/**
 * Terrain from the Copernicus DEM (Phase 2) — slope, hillshade and a
 * terrain-shadow mask used to suppress false "water" in radar/optical shadow.
 *
 * ── Source (verified against Sentinel Hub docs, 2026-11) ───────────────────
 * Dataset type "dem" (previously DEM), dataFilter.demInstance:
 *   COPERNICUS_30 — GLO-30 Public (30 m; CDSE notes it may require
 *                   registration) → tried FIRST
 *   COPERNICUS_90 — GLO-90 global, the CDSE default → fallback
 * Evalscript band "DEM" = elevation in metres, output FLOAT32.
 * Docs: https://docs.sentinel-hub.com/api/latest/data/dem/
 *       https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/DEM.html
 *
 * Each attempt is ONE Process render (counts against DAILY_RENDER_BUDGET /
 * PU estimate). Failure of both instances → null: terrain suppression is
 * skipped for the run (method card: "Terrain: off"), never an error.
 *
 * ── How it is used (Phase 3) ───────────────────────────────────────────────
 * hillshade < TERRAIN_SHADOW_HS → terrain-shadow pixel: candidate water
 * (MNDWI/SAR votes) there is suppressed — shadowed slopes and radar-shadow
 * bands mimic open water in both SAR backscatter and SWIR indices.
 * slopeDeg is computed alongside (surfaced in diagnostics; also flags
 * layover-prone terrain where SAR evidence is unreliable).
 */
import { fetchAnalysisRaster, type CompareRasterSize } from "./fetch";
import type { ClipGeometry } from "@/lib/cdse/geometry";
import type { AnalysisGrid } from "./types";

/** Single-band elevation (metres) render. */
export const DEM_EVALSCRIPT = `//VERSION=3
function setup() {
  return { input: ["DEM"], output: { bands: 1, sampleType: "FLOAT32" } };
}
function evaluatePixel(sample) {
  return [sample.DEM];
}`;

/** Hillshade below this (0..1, sun 315°/45°) counts as terrain shadow. */
export const TERRAIN_SHADOW_HS = 0.2;
/** Sun geometry for the hillshade (standard cartographic defaults). */
export const HILLSHADE_AZIMUTH_DEG = 315;
export const HILLSHADE_ALTITUDE_DEG = 45;
/** Tried first (30 m where available), then the CDSE default GLO-90. */
export const DEM_INSTANCES = ["COPERNICUS_30", "COPERNICUS_90"] as const;

/** Process API `input.data` entry for one DEM instance (docs option names). */
export function demDataEntry(demInstance: string): {
  type: string;
  dataFilter: Record<string, string>;
  processing: Record<string, string>;
} {
  return {
    type: "dem",
    dataFilter: { demInstance },
    processing: { upsampling: "BILINEAR", downsampling: "BILINEAR" },
  };
}

export interface ElevationRender {
  buffer: Buffer;
  demInstance: string;
}

/**
 * Renders elevation on the analysis grid. Tries COPERNICUS_30 then
 * COPERNICUS_90; budget/auth failures short-circuit (deterministic).
 * Returns null when every instance fails — caller degrades gracefully.
 */
export async function fetchElevationRaster(
  geometry: ClipGeometry,
  size: CompareRasterSize,
): Promise<ElevationRender | null> {
  for (const demInstance of DEM_INSTANCES) {
    try {
      const buffer = await fetchAnalysisRaster({
        geometry,
        evalscript: DEM_EVALSCRIPT,
        size,
        data: [demDataEntry(demInstance)],
      });
      return { buffer, demInstance };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "DAILY_BUDGET_EXCEEDED" || code === "CDSE_AUTH") return null;
    }
  }
  return null;
}

export interface TerrainGrids {
  /** Slope in degrees (Horn 3×3). */
  slopeDeg: Float32Array;
  /** Hillshade 0..1 (sun azimuth 315°, altitude 45°). */
  hillshade: Float32Array;
  /** 1 = hillshade < TERRAIN_SHADOW_HS (suppress candidate water here). */
  shadow: Uint8Array;
}

const DEG2RAD = Math.PI / 180;

function clampIdx(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/**
 * Slope + hillshade from an elevation raster already on the analysis grid.
 * Horn 3×3 with border replication; flat terrain → hillshade = sin(45°).
 * Pure and allocation-light — unit-tested with known surfaces.
 */
export function computeTerrain(
  elevation: Float32Array,
  grid: Pick<AnalysisGrid, "width" | "height" | "metersX" | "metersY">,
): TerrainGrids {
  const { width, height, metersX, metersY } = grid;
  const n = width * height;
  if (elevation.length !== n) {
    throw new Error(`computeTerrain: size mismatch ${elevation.length} vs ${n}`);
  }
  const slopeDeg = new Float32Array(n);
  const hillshade = new Float32Array(n);
  const shadow = new Uint8Array(n);

  const alt = HILLSHADE_ALTITUDE_DEG * DEG2RAD;
  const az = HILLSHADE_AZIMUTH_DEG * DEG2RAD;
  const sinAlt = Math.sin(alt);
  const cosAlt = Math.cos(alt);

  const at = (row: number, col: number): number =>
    elevation[clampIdx(row, height - 1) * width + clampIdx(col, width - 1)];

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      // Horn 3×3: a b c / d e f / g h i (rows top→bottom = north→south).
      const tl = at(row - 1, col - 1);
      const tc = at(row - 1, col);
      const tr = at(row - 1, col + 1);
      const ml = at(row, col - 1);
      const mr = at(row, col + 1);
      const bl = at(row + 1, col - 1);
      const bc = at(row + 1, col);
      const br = at(row + 1, col + 1);

      const dzdEast = (tr + 2 * mr + br - (tl + 2 * ml + bl)) / (8 * metersX);
      // Rows run north→south, so row-down = south; north gradient negates it.
      const dzdSouth = (bl + 2 * bc + br - (tl + 2 * tc + tr)) / (8 * metersY);
      const dzdNorth = -dzdSouth;

      const slope = Math.atan(Math.hypot(dzdEast, dzdNorth));
      const i = row * width + col;
      slopeDeg[i] = slope / DEG2RAD;

      // Downslope bearing, clockwise from north (0 = north, 90 = east).
      const bearing = Math.atan2(-dzdEast, -dzdNorth);
      let hs =
        sinAlt * Math.cos(slope) + cosAlt * Math.sin(slope) * Math.cos(az - bearing);
      hs = hs < 0 ? 0 : hs > 1 ? 1 : hs;
      hillshade[i] = hs;
      shadow[i] = hs < TERRAIN_SHADOW_HS ? 1 : 0;
    }
  }
  return { slopeDeg, hillshade, shadow };
}
