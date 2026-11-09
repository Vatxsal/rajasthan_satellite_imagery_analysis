/**
 * Sentinel-1 GRD evidence for the fused change rules (Phase 1).
 *
 * ── Request shape (verified against Sentinel Hub docs, 2026-11) ─────────────
 * Dataset type "sentinel-1-grd" (renamed from "S1GRD") with:
 *   dataFilter:  acquisitionMode "IW" · polarization "DV" (dual VV+VH)
 *                · resolution "HIGH" (10 m/px for IW) · orbitDirection
 *                ASCENDING | DESCENDING · timeRange ±S1_WINDOW_DAYS
 *   processing:  backCoeff "GAMMA0_TERRAIN" — terrain-corrected gamma0
 *                (docs: BETA0 | SIGMA0_ELLIPSOID | GAMMA0_ELLIPSOID (default)
 *                | GAMMA0_TERRAIN; terrain correction needs orthorectify)
 *                · orthorectify "true" (string, per docs examples)
 *                · demInstance "COPERNICUS_30" — Copernicus DEM, global
 *                coverage for S1 processing (CDSE S1GRD docs)
 *                · speckleFilter { type: "LEE", windowSizeX/Y: 5 } — built-in
 *                spatial speckle reduction (docs examples) on top of the
 *                temporal median in the evalscript.
 * Output grid = same width/height/geometry as the optical request, so S1 and
 * S2 pixels line up 1:1 (the Process API renders both into the requested grid).
 * Docs: https://docs.sentinel-hub.com/api/latest/data/sentinel-1-grd/
 *       https://documentation.dataspace.copernicus.eu/APIs/SentinelHub/Data/S1GRD.html
 *
 * ── Orbit discipline ────────────────────────────────────────────────────────
 * One orbit direction per side, and the SAME direction for both sides: look
 * geometry differs between ASC/DESC, so a cross-direction Δ would mix real
 * change with incidence-angle effects. We probe ASCENDING first for side A;
 * if A has data we probe B with the same direction, otherwise we fall back to
 * DESCENDING for both. No common direction with data on both sides → SAR is
 * skipped for the run (null) — never mixed.
 *
 * ── LIMITS (also README) ────────────────────────────────────────────────────
 * SAR backscatter changes with crop structure, soil moisture and wind as well
 * as with built-up surfaces and open water:
 *   - dVV/dVH/dVV-VH are CORROBORATING evidence only — SAR alone NEVER
 *     creates a built-up event; the fused rules require optical agreement.
 *   - soil moisture darkens bare fields (false "water-like" drop), recent
 *     rain brightens/changes fields; the adaptive water threshold can split
 *     a uniformly dark scene (dry lakebed, smooth basalt) into fake water.
 *   - layover/shadow in terrain distorts both backscatter and the water
 *     mask (Phase 2 adds slope/hillshade suppression).
 */
import { compositeTimeRange } from "./composite";
import {
  fetchAnalysisRaster,
  type CompareRasterSize,
  type ProcessDataInput,
} from "./fetch";
import { S1_EVALSCRIPT } from "./evalscript";
import { parseS1Side, type ParsedS1Side } from "./parse";
import type { ClipGeometry } from "@/lib/cdse/geometry";

/** ±days around each date for the S1 temporal median (env S1_WINDOW_DAYS). */
export const S1_WINDOW_DAYS_DEFAULT = 6;
/** Probed directions, in preference order (first with data on BOTH sides wins). */
export const S1_ORBITS = ["ASCENDING", "DESCENDING"] as const;
export type S1Orbit = (typeof S1_ORBITS)[number];

/** Sane bounds for the adaptive VH-dB water threshold (tunable, documented). */
export const WATER_VH_DB_MIN = -35;
export const WATER_VH_DB_MAX = -12;
/** Histogram bins for Otsu over the valid-pixel VH-dB distribution. */
export const WATER_OTSU_BINS = 128;

/** The Process API `input.data` entry for one S1 side (option names per docs). */
export function s1DataEntry(
  orbit: S1Orbit,
  timeRange: { from: string; to: string },
): ProcessDataInput {
  return {
    type: "sentinel-1-grd",
    dataFilter: {
      timeRange,
      acquisitionMode: "IW",
      polarization: "DV", // dual VV+VH
      resolution: "HIGH", // 10 m/px for IW
      orbitDirection: orbit,
    },
    processing: {
      backCoeff: "GAMMA0_TERRAIN", // terrain-corrected gamma0
      orthorectify: "true",
      demInstance: "COPERNICUS_30", // Copernicus DEM (global for S1)
      speckleFilter: { type: "LEE", windowSizeX: 5, windowSizeY: 5 },
    },
  };
}

/** Fetches one side's S1 raster (median VV/VH/count on the optical grid). */
export async function fetchS1Side(
  geometry: ClipGeometry,
  date: string,
  windowDays: number,
  otherDate: string,
  size: CompareRasterSize,
  orbit: S1Orbit,
): Promise<Buffer> {
  const timeRange = compositeTimeRange(date, windowDays, otherDate);
  return fetchAnalysisRaster({
    geometry,
    evalscript: S1_EVALSCRIPT,
    size,
    data: [s1DataEntry(orbit, timeRange)],
  });
}

/** dB conversion of linear power; ≤ 0 (nodata) → NaN. */
export function toDb(linear: number): number {
  return linear > 0 ? (10 * Math.log(linear)) / Math.LN10 : NaN;
}

/** True when the side has at least one pixel with a valid observation. */
export function sideHasData(side: ParsedS1Side): boolean {
  for (let i = 0; i < side.count.length; i++) {
    if (side.count[i] >= 1) return true;
  }
  return false;
}

/**
 * Otsu's method over the valid-pixel VH-dB histogram, bounded to
 * [WATER_VH_DB_MIN, WATER_VH_DB_MAX]. Returns NaN when no valid pixel exists.
 */
export function otsuVhThreshold(
  vhDb: Float32Array,
  valid: Uint8Array,
): number {
  const n = vhDb.length;
  const lo = WATER_VH_DB_MIN;
  const hi = WATER_VH_DB_MAX;
  const bins = WATER_OTSU_BINS;
  const hist = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (valid[i] !== 1) continue;
    const v = vhDb[i];
    if (!Number.isFinite(v)) continue;
    let b = Math.floor(((v - lo) / (hi - lo)) * bins);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    hist[b] += 1;
    total += 1;
  }
  if (total === 0) return NaN;

  const binWidth = (hi - lo) / bins;
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += (lo + (b + 0.5) * binWidth) * hist[b];

  let sumB = 0;
  let wB = 0;
  let best = -1;
  let bestT = lo;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += (lo + (b + 0.5) * binWidth) * hist[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      // Water = dark class → threshold at the top edge of the dark bin.
      bestT = lo + (b + 1) * binWidth;
    }
  }
  return Math.min(hi, Math.max(lo, bestT));
}

/** Adaptive radar water mask: valid AND VH_dB ≤ Otsu threshold (bounded). */
export function radarWaterMask(
  vhDb: Float32Array,
  valid: Uint8Array,
): { mask: Uint8Array; threshold: number } {
  const threshold = otsuVhThreshold(vhDb, valid);
  const mask = new Uint8Array(vhDb.length);
  if (!Number.isFinite(threshold)) return { mask, threshold };
  for (let i = 0; i < mask.length; i++) {
    mask[i] = valid[i] === 1 && vhDb[i] <= threshold ? 1 : 0;
  }
  return { mask, threshold };
}

export interface SarFeatures {
  /** ΔVV (dB), B − A; NaN where either side invalid. */
  dVV: Float32Array;
  /** ΔVH (dB), B − A; NaN where either side invalid. */
  dVH: Float32Array;
  /** Δ(VV−VH) ratio in dB, B − A; NaN where either side invalid. */
  dRatio: Float32Array;
  /** Radar water mask per side (adaptive Otsu on VH). */
  waterMaskA: Uint8Array;
  waterMaskB: Uint8Array;
  /** Otsu thresholds used (dB, NaN when a side has no valid pixel). */
  thresholdA: number;
  thresholdB: number;
  /** 1 where BOTH sides have a valid S1 observation. */
  valid: Uint8Array;
}

/** Computes the Phase 1 feature stack from the two parsed S1 sides. */
export function sarFeatures(a: ParsedS1Side, b: ParsedS1Side): SarFeatures {
  const n = a.vvDb.length;
  if (b.vvDb.length !== n) {
    throw new Error(`sarFeatures: size mismatch ${n} vs ${b.vvDb.length}`);
  }
  const dVV = new Float32Array(n);
  const dVH = new Float32Array(n);
  const dRatio = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (a.valid[i] !== 1 || b.valid[i] !== 1) {
      dVV[i] = NaN;
      dVH[i] = NaN;
      dRatio[i] = NaN;
      continue;
    }
    valid[i] = 1;
    dVV[i] = b.vvDb[i] - a.vvDb[i];
    dVH[i] = b.vhDb[i] - a.vhDb[i];
    // ratio dB = VV_dB − VH_dB; Δratio = ΔVV − ΔVH.
    dRatio[i] = dVV[i] - dVH[i];
  }
  const wa = radarWaterMask(a.vhDb, a.valid);
  const wb = radarWaterMask(b.vhDb, b.valid);
  return {
    dVV,
    dVH,
    dRatio,
    waterMaskA: wa.mask,
    waterMaskB: wb.mask,
    thresholdA: wa.threshold,
    thresholdB: wb.threshold,
    valid,
  };
}

/* ------------------------------------------------------------------ */
/* pair fetch (one orbit direction for both sides)                     */
/* ------------------------------------------------------------------ */

export interface S1PairOk {
  ok: true;
  a: ParsedS1Side;
  b: ParsedS1Side;
  orbit: S1Orbit;
}
export interface S1PairSkipped {
  ok: false;
  /** disabled (caller-side) | no-common-orbit | fetch-failed */
  reason: "no-common-orbit" | "fetch-failed";
  detail?: string;
}
export type S1PairOutcome = S1PairOk | S1PairSkipped;

/** Injectable I/O so the orbit-fallback logic is unit-testable offline. */
export interface S1FetchDeps {
  fetchSide: (
    date: string,
    otherDate: string,
    orbit: S1Orbit,
  ) => Promise<Buffer>;
  parseSide: (buffer: Buffer) => Promise<ParsedS1Side>;
}

/** Production deps: real Process fetch (budget-consuming) + geotiff parse. */
export function defaultS1Deps(
  geometry: ClipGeometry,
  windowDays: number,
  size: CompareRasterSize,
): S1FetchDeps {
  return {
    fetchSide: (date, otherDate, orbit) =>
      fetchS1Side(geometry, date, windowDays, otherDate, size, orbit),
    parseSide: parseS1Side,
  };
}

/**
 * Fetches side A then B for one direction; if either side lacks data, retries
 * BOTH sides with the next direction (never mixes directions). Returns
 * `fetch-failed` only when a fetch/parse threw; a direction with data on A but
 * not B just falls through to the next one.
 */
export async function fetchS1Pair(
  params: { dateA: string; dateB: string },
  deps: S1FetchDeps,
): Promise<S1PairOutcome> {
  let lastError: unknown;
  for (const orbit of S1_ORBITS) {
    try {
      const aBuf = await deps.fetchSide(params.dateA, params.dateB, orbit);
      const a = await deps.parseSide(aBuf);
      if (!sideHasData(a)) continue; // wrong/empty orbit → try next direction
      const bBuf = await deps.fetchSide(params.dateB, params.dateA, orbit);
      const b = await deps.parseSide(bBuf);
      if (!sideHasData(b)) continue;
      return { ok: true, a, b, orbit };
    } catch (error) {
      lastError = error;
      // Budget/auth errors are deterministic — a second direction cannot
      // succeed either, so stop probing.
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "DAILY_BUDGET_EXCEEDED" || code === "CDSE_AUTH") {
        return { ok: false, reason: "fetch-failed", detail: String(code) };
      }
    }
  }
  if (lastError) {
    return { ok: false, reason: "fetch-failed", detail: String(lastError) };
  }
  return { ok: false, reason: "no-common-orbit" };
}
