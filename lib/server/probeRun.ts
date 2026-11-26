/**
 * Phase 4 — change probe orchestration: a ~480 m native-resolution window
 * around the clicked point runs through the same pipeline (fetch → classify →
 * denoise → MMU) and the pure verdict logic (lib/analysis/probe) explains
 * the pixel: kept patch, MMU-cut patch, sub-threshold deltas or masked data.
 *
 * The verdict reflects the WINDOW run, not the cached whole-AOI artifact —
 * that is the point: it measures what the classifiers see at native 10 m
 * with the request's sensitivity/minimum-patch settings.
 */
import { runCompare } from "@/lib/analysis/analyze";
import { interpretProbe, type ProbeResult } from "@/lib/analysis/probe";
import { makeAnalysisGrid } from "@/lib/analysis/grid";
import { M2_PER_HA } from "@/lib/analysis/config";
import { getServerEnv } from "@/lib/env";
import type { ResolvedCompareParams } from "@/lib/server/compareRun";

/** Probe window edge (metres) — 48 px at the 10 m native grid. */
export const PROBE_WINDOW_M = 480;
/** Exact window raster (48×48 at native 10 m). */
export const PROBE_WINDOW_PX = 48;

function windowGeometry(
  lng: number,
  lat: number,
): { geometry: GeoJSON.Polygon; bbox: [number, number, number, number] } {
  const midLatRad = (lat * Math.PI) / 180;
  const lonSpan = PROBE_WINDOW_M / (111_320 * Math.cos(midLatRad));
  const latSpan = PROBE_WINDOW_M / 110_574;
  const bbox: [number, number, number, number] = [
    lng - lonSpan / 2,
    lat - latSpan / 2,
    lng + lonSpan / 2,
    lat + latSpan / 2,
  ];
  const geometry: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[2], bbox[3]],
        [bbox[0], bbox[3]],
        [bbox[0], bbox[1]],
      ],
    ],
  };
  return { geometry, bbox };
}

/**
 * Runs the probe window and interprets its center pixel. The point is
 * assumed validated (inside the selected area) by the route.
 */
export async function runProbe(
  resolved: ResolvedCompareParams,
  lng: number,
  lat: number,
): Promise<ProbeResult> {
  const env = getServerEnv();
  const { geometry, bbox } = windowGeometry(lng, lat);
  const size = { width: PROBE_WINDOW_PX, height: PROBE_WINDOW_PX };
  const artifact = await runCompare({
    geometry,
    dateA: resolved.dateA,
    dateB: resolved.dateB,
    areaName: `Probe ${resolved.area.name}`,
    areaLevel: resolved.area.level,
    areaId: resolved.area.id,
    sensitivity: resolved.sensitivity,
    minPatchHa: resolved.minPatchHa,
    speckle: resolved.speckle,
    outputSize: size,
    zones: null,
    engine: resolved.engine,
    inputMode: resolved.inputMode,
    compositeWindowDays: resolved.compositeWindowDays,
    rules: resolved.rules,
    sharpen: resolved.sharpen,
    evidencePlan:
      resolved.rules !== "legacy"
        ? { s1WindowDays: env.S1_ENABLED ? env.S1_WINDOW_DAYS : null, terrain: true }
        : null,
  });
  const grid = makeAnalysisGrid(bbox, size.width, size.height);
  const pxAreaHa = (grid.metersX * grid.metersY) / M2_PER_HA;
  const centerIdx = Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2);
  return interpretProbe({
    classGrid: artifact.classGrid,
    labels: artifact.labels,
    tiers: artifact.tiers,
    coverage: artifact.coverage,
    magnitude: artifact.magnitude,
    thresholds: artifact.result.metadata.thresholds,
    width: size.width,
    height: size.height,
    pxAreaHa,
    minPatchHa: resolved.minPatchHa,
    centerIdx,
  });
}
