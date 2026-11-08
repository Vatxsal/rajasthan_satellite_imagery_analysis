/**
 * ESA WorldCover land-cover prior (Phase 2, optional — env WORLDCOVER_ENABLED).
 *
 * ── Source (official, verified 2026-11 — URL pattern NOT guessed) ──────────
 * ESA WorldCover data access page + Product User Manual V2.0 §3.1/§5.3:
 *   https://esa-worldcover.org/en/data-access
 *   https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/docs/WorldCover_PUM_V2.0.pdf
 * - 2021 map (algorithm v200), 3×3° Cloud-Optimized GeoTIFF tiles, EPSG:4326,
 *   ~10 m, internal overviews 2..64 → clipped windows read with range
 *   requests (geotiff fromUrl), never the full ~117 GB layer.
 * - Tile naming (PUM §3.1, example S48E036): SW corner of the 3° tile.
 * - URL per the official AWS snippet (PUM §5.3):
 *   https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/
 *     ESA_WorldCover_10m_2021_v200_{tile}_Map.tif
 * - License: CC-BY 4.0, free of charge, no restriction of use; attribution
 *   string below is REQUIRED on published maps (official citation section).
 *
 * ── How the fused rules use it (Phase 3) ───────────────────────────────────
 * (a) pixels already class 50 (Built-up) before date A cannot become NEW
 *     built-up — the event is downgraded to bare_surface / no event;
 * (b) bare-surface change on class 40 (Cropland) is tagged bare_agri with a
 *     confidence penalty (likely harvest/tillage, not construction);
 * (c) class 80 (Permanent water bodies) is excluded from water_gain — it was
 *     already water before date A.
 *
 * ── LIMITS ─────────────────────────────────────────────────────────────────
 * - Static 2021 prior: a conversion after 2021 still shows its pre-2021
 *   class (fine for gating), but a water body that dried BEFORE 2021 and
 *   refills by date B is wrongly excluded from water_gain.
 * - Product accuracy 76.7% (PVR V2.0) — cropland/grassland/bare confusion
 *   only moves confidence, never hard-switches a class.
 * - Fetch failure (no network, blocked S3, …) → returns null: the feature is
 *   simply OFF for that run (method card shows "WorldCover: off"), never an
 *   error. Attribution must accompany any map that shows prior-derived tags.
 */
import { sharedInstance } from "../singleton";
import type { BBox } from "@/lib/data";

/** Official S3 prefix (AWS Open Data Registry: esa-worldcover, eu-central-1). */
export const WORLDCOVER_URL_PREFIX =
  "https://esa-worldcover.s3.eu-central-1.amazonaws.com";
export const WORLDCOVER_YEAR = 2021;
export const WORLDCOVER_VERSION = "v200";
/** CC-BY 4.0 attribution — required on published maps (official citation). */
export const WORLDCOVER_ATTRIBUTION =
  "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium";

/** WorldCover 11-class scheme (PUM Table 3). */
export const WC = {
  nodata: 0,
  trees: 10,
  shrubland: 20,
  grassland: 30,
  cropland: 40,
  builtup: 50,
  bare: 60,
  snow: 70,
  water: 80,
  wetland: 90,
  mangrove: 95,
  moss: 100,
} as const;

/** 3° tile grid size (PUM §3). */
export const WC_TILE_DEG = 3;

/**
 * Tile id from the SW corner degree (PUM §3.1 naming):
 * worldCoverTileId(24, 69) → "N24E069", worldCoverTileId(-48, 36) → "S48E036".
 */
export function worldCoverTileId(latSw: number, lonSw: number): string {
  const ns = latSw >= 0 ? "N" : "S";
  const ew = lonSw >= 0 ? "E" : "W";
  return `${ns}${String(Math.abs(latSw)).padStart(2, "0")}${ew}${String(Math.abs(lonSw)).padStart(3, "0")}`;
}

/**
 * All 3° tiles intersecting the bbox (deduped, south→north then west→east).
 * Exact multiples: a bbox edge of exactly 24.0 belongs to the tile BELOW
 * (24 is the northern edge of 21..24), so the far edge uses an epsilon.
 */
export function worldCoverTilesForBbox(bbox: BBox): string[] {
  const [west, south, east, north] = bbox;
  const eps = 1e-9;
  const lat0 = Math.floor(south / WC_TILE_DEG) * WC_TILE_DEG;
  const lat1 = Math.floor((north - eps) / WC_TILE_DEG) * WC_TILE_DEG;
  const lon0 = Math.floor(west / WC_TILE_DEG) * WC_TILE_DEG;
  const lon1 = Math.floor((east - eps) / WC_TILE_DEG) * WC_TILE_DEG;
  const ids: string[] = [];
  for (let lat = lat0; lat <= lat1; lat += WC_TILE_DEG) {
    for (let lon = lon0; lon <= lon1; lon += WC_TILE_DEG) {
      ids.push(worldCoverTileId(lat, lon));
    }
  }
  return ids;
}

/** Official per-tile Map COG URL (pattern from the PUM §5.3 AWS snippet). */
export function worldCoverTileUrl(tileId: string): string {
  return `${WORLDCOVER_URL_PREFIX}/v${WORLDCOVER_VERSION.slice(1)}/${WORLDCOVER_YEAR}/map/ESA_WorldCover_10m_${WORLDCOVER_YEAR}_${WORLDCOVER_VERSION}_${tileId}_Map.tif`;
}

/** The analysis grid the prior is sampled onto (linear bbox mapping). */
export interface PriorGrid {
  /** [west, south, east, north] EPSG:4326. */
  bbox: BBox;
  width: number;
  height: number;
  pxLon: number;
  pxLat: number;
}

/** One tile's contribution to the merged prior grid. */
export interface TileRead {
  /** Placement of values[0] in the output grid. */
  col0: number;
  row0: number;
  cols: number;
  rows: number;
  /** cols×rows WorldCover class values, row-major. */
  values: Uint8Array;
}

export interface WorldCoverDeps {
  /** Reads the COG window for this tile, resampled to the grid placement. */
  readTile: (url: string, grid: PriorGrid) => Promise<TileRead | null>;
}

export interface WorldCoverPrior {
  /** WorldCover class per grid pixel (WC.nodata where unavailable). */
  cls: Uint8Array;
  /** 1 where a tile covered this pixel. */
  valid: Uint8Array;
  tiles: string[];
  year: number;
}

function gridKey(grid: PriorGrid): string {
  const [w, s, e, n] = grid.bbox;
  return `${w.toFixed(6)},${s.toFixed(6)},${e.toFixed(6)},${n.toFixed(6)}|${grid.width}x${grid.height}`;
}

/** globalThis cache — clipped windows are tiny (≤ width×height bytes). */
const cache = sharedInstance("rse.worldCoverCache", () => ({
  map: new Map<string, WorldCoverPrior>(),
}));
const CACHE_MAX = 8;

/**
 * Fetches (and caches) the WorldCover prior for the grid.
 * Never throws: any failure → null (feature off for this run).
 */
export async function fetchWorldCoverPrior(
  grid: PriorGrid,
  deps: WorldCoverDeps,
): Promise<WorldCoverPrior | null> {
  const key = gridKey(grid);
  const hit = cache.map.get(key);
  if (hit) return hit;

  const tiles = worldCoverTilesForBbox(grid.bbox);
  const cls = new Uint8Array(grid.width * grid.height);
  const valid = new Uint8Array(grid.width * grid.height);
  let any = false;

  for (const tileId of tiles) {
    try {
      const read = await deps.readTile(worldCoverTileUrl(tileId), grid);
      if (!read || read.cols <= 0 || read.rows <= 0) continue;
      for (let r = 0; r < read.rows; r++) {
        const row = read.row0 + r;
        if (row < 0 || row >= grid.height) continue;
        for (let c = 0; c < read.cols; c++) {
          const col = read.col0 + c;
          if (col < 0 || col >= grid.width) continue;
          cls[row * grid.width + col] = read.values[r * read.cols + c];
          valid[row * grid.width + col] = 1;
        }
      }
      any = true;
    } catch {
      // per-tile failure → partial prior; total failure → null below
    }
  }
  if (!any) return null;

  const prior: WorldCoverPrior = { cls, valid, tiles, year: WORLDCOVER_YEAR };
  if (cache.map.size >= CACHE_MAX) {
    const oldest = cache.map.keys().next().value;
    if (oldest !== undefined) cache.map.delete(oldest);
  }
  cache.map.set(key, prior);
  return prior;
}

/** Test hook — clears the module cache between cases. */
export function clearWorldCoverCache(): void {
  cache.map.clear();
}

/** Prior predicates consumed by the fused rules (Phase 3). */
export function priorIsBuiltup(prior: WorldCoverPrior, i: number): boolean {
  return prior.valid[i] === 1 && prior.cls[i] === WC.builtup;
}
export function priorIsCropland(prior: WorldCoverPrior, i: number): boolean {
  return prior.valid[i] === 1 && prior.cls[i] === WC.cropland;
}
export function priorIsWater(prior: WorldCoverPrior, i: number): boolean {
  return prior.valid[i] === 1 && prior.cls[i] === WC.water;
}

/**
 * Default deps: geotiff COG range-read of the tile window covering the grid
 * placement (nearest resampling — categorical classes must not be blended).
 */
export async function defaultWorldCoverDeps(): Promise<WorldCoverDeps> {
  const { fromUrl } = await import("geotiff");
  return {
    readTile: async (url, grid) => {
      const tiff = await fromUrl(url);
      const image = await tiff.getImage();
      const bb = image.getBoundingBox(); // [west, south, east, north]
      const [gw, gs, ge, gn] = grid.bbox;
      const west = Math.max(gw, bb[0]);
      const south = Math.max(gs, bb[1]);
      const east = Math.min(ge, bb[2]);
      const north = Math.min(gn, bb[3]);
      if (west >= east || south >= north) return null;

      const col0 = Math.max(0, Math.floor((west - gw) / grid.pxLon));
      const col1 = Math.min(grid.width, Math.ceil((east - gw) / grid.pxLon));
      const row0 = Math.max(0, Math.floor((gn - north) / grid.pxLat));
      const row1 = Math.min(grid.height, Math.ceil((gn - south) / grid.pxLat));
      const cols = col1 - col0;
      const rows = row1 - row0;
      if (cols <= 0 || rows <= 0) return null;

      // Grid window extent in lon/lat → window in the tile's own pixels.
      const winW = gw + col0 * grid.pxLon;
      const winE = gw + col1 * grid.pxLon;
      const winN = gn - row0 * grid.pxLat;
      const winS = gn - row1 * grid.pxLat;
      const imgW = image.getWidth();
      const imgH = image.getHeight();
      const pxLonT = (bb[2] - bb[0]) / imgW;
      const pxLatT = (bb[3] - bb[1]) / imgH;
      const x0 = Math.max(0, Math.floor((winW - bb[0]) / pxLonT));
      const x1 = Math.min(imgW, Math.ceil((winE - bb[0]) / pxLonT));
      const y0 = Math.max(0, Math.floor((bb[3] - winN) / pxLatT));
      const y1 = Math.min(imgH, Math.ceil((bb[3] - winS) / pxLatT));
      if (x1 <= x0 || y1 <= y0) return null;

      const rasters = (await image.readRasters({
        window: [x0, y0, x1, y1],
        width: cols,
        height: rows,
        resampleMethod: "nearest",
      })) as Uint8Array[];
      return { col0, row0, cols, rows, values: rasters[0] };
    },
  };
}
