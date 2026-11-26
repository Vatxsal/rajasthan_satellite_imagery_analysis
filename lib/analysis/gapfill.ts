/**
 * Phase 1 — coverage rescue ("gap fill"): when a side arrives with too little
 * usable data over the polygon, a wider ±window composite render is fetched
 * and merged in — only at the pixels the primary fetch could not analyse.
 * Pure merge/decision maths (the fetch lives in analyze.ts) so the validation
 * harness can drive it without Sentinel Hub.
 *
 * Semantics:
 *  - filled pixels become valid, marked `source = 1` (their values come from
 *    a ±window median, not the anchor day — the map layer shows them);
 *  - still-invalid pixels adopt the rescue's missing/cloud flags, so the
 *    coverage reasons describe the whole rescue window honestly;
 *  - the anchor day's own pixels are never touched (change detection keeps
 *    comparing A vs B as requested).
 */
import { COMPOSITE_WINDOW_DAYS_MAX } from "./config";
import type { ParsedCompositeRaster } from "./parse";
import type { IndexRasters } from "./types";

/** Below this inside-coverage share a side gets the rescue render. */
export const GAP_FILL_MIN_COVERAGE_PCT = 95;
/** Rescue window (±days) — also the window for a single-day primary. */
export const GAP_FILL_WINDOW_DAYS = 3;

/** Everything the pipeline/method card needs about a rescue run. */
export interface GapFillInfo {
  /** 0 = primary fetch, 1 = value came from the rescue window. */
  source: Uint8Array;
  /** ±days window of the rescue render. */
  windowDays: number;
  /** Sides actually rescued ("A" / "B"). */
  sides: string[];
  /** Inside pixels only valid thanks to the rescue, % of the polygon. */
  filledPct: number;
}

/** Inside pixels with valid data, as a percent (100 when the polygon is empty). */
export function insideValidPct(inside: Uint8Array, valid: Uint8Array): number {
  let total = 0;
  let ok = 0;
  for (let i = 0; i < inside.length; i++) {
    if (inside[i] !== 1) continue;
    total += 1;
    if (valid[i] === 1) ok += 1;
  }
  return total === 0 ? 100 : (ok / total) * 100;
}

export function insidePixelCount(inside: Uint8Array): number {
  let total = 0;
  for (let i = 0; i < inside.length; i++) if (inside[i] === 1) total += 1;
  return total;
}

export function needsGapFill(coveragePct: number): boolean {
  return coveragePct < GAP_FILL_MIN_COVERAGE_PCT;
}

/**
 * Rescue window for a primary window: at least ±3 days, otherwise 3 days
 * wider than the primary (capped at the engine maximum). Returns null when
 * nothing wider exists — the rescue would just re-fetch the same render.
 */
export function rescueWindowDays(primaryWindow: number): number | null {
  const rescue = Math.min(
    COMPOSITE_WINDOW_DAYS_MAX,
    Math.max(GAP_FILL_WINDOW_DAYS, primaryWindow + GAP_FILL_WINDOW_DAYS),
  );
  return rescue === primaryWindow ? null : rescue;
}

/** v1 side shape (structurally compatible with process.ts CompareSide). */
export interface CompareSideLike {
  indices: IndexRasters;
  valid: Uint8Array;
  nodata?: Uint8Array;
  width: number;
  height: number;
}

/**
 * Fills the primary v1 side's invalid pixels from the rescue side.
 * Returns the number of inside-boundary pixels filled (the caller scopes
 * `source` to the polygon; pixels outside are never consulted here).
 */
export function mergeCompareSide(
  primary: CompareSideLike,
  rescue: CompareSideLike,
  source: Uint8Array,
): number {
  let filled = 0;
  const n = primary.valid.length;
  for (let i = 0; i < n; i++) {
    if (primary.valid[i] === 1) continue;
    if (rescue.valid[i] === 1) {
      primary.indices.ndvi[i] = rescue.indices.ndvi[i];
      primary.indices.mndwi[i] = rescue.indices.mndwi[i];
      primary.indices.ndbi[i] = rescue.indices.ndbi[i];
      primary.valid[i] = 1;
      if (primary.nodata) primary.nodata[i] = 0;
      source[i] = 1;
      filled += 1;
    } else if (primary.nodata && rescue.nodata) {
      // Still invalid → describe the whole rescue window: a pixel with no
      // acquisition across ±window is "missing", not "cloudy that day".
      primary.nodata[i] = rescue.nodata[i];
    }
  }
  return filled;
}

/** Composite fields copied wholesale at rescued pixels. */
const COMPOSITE_FILL_FIELDS = [
  "b02",
  "b03",
  "b04",
  "b05",
  "b08",
  "b11",
  "b12",
  "obsCount",
  "scl",
  "recentNdvi",
  "recentMndwi",
  "recentNdbi",
] as const;

/** Fills the primary v2 composite's invalid pixels from the rescue render. */
export function mergeCompositeSide(
  primary: ParsedCompositeRaster,
  rescue: ParsedCompositeRaster,
  source: Uint8Array,
): number {
  let filled = 0;
  const n = primary.valid.length;
  for (let i = 0; i < n; i++) {
    if (primary.valid[i] === 1) continue;
    if (rescue.valid[i] === 1) {
      for (const field of COMPOSITE_FILL_FIELDS) primary[field][i] = rescue[field][i];
      primary.valid[i] = 1;
      if (primary.cloudyObs && rescue.cloudyObs) primary.cloudyObs[i] = 0;
      if (primary.nodataObs && rescue.nodataObs) primary.nodataObs[i] = 0;
      source[i] = 1;
      filled += 1;
    } else {
      // Adopt the rescue window's QC counts (a superset of the primary's
      // window) so missing vs cloud stays honest for the whole window.
      if (primary.cloudyObs && rescue.cloudyObs) primary.cloudyObs[i] = rescue.cloudyObs[i];
      if (primary.nodataObs && rescue.nodataObs) primary.nodataObs[i] = rescue.nodataObs[i];
    }
  }
  return filled;
}

/** Per-pixel "no acquisition anywhere in the rescue window" flag for a
 *  rescued composite — feeds the v1 side's nodata semantics. */
export function rescueNodataFlags(parsed: ParsedCompositeRaster): Uint8Array {
  const n = parsed.valid.length;
  const out = new Uint8Array(n);
  if (!parsed.nodataObs) return out;
  for (let i = 0; i < n; i++) {
    const cloudy = parsed.cloudyObs ? parsed.cloudyObs[i] : 0;
    out[i] = parsed.nodataObs[i] > 0 && cloudy === 0 ? 1 : 0;
  }
  return out;
}
