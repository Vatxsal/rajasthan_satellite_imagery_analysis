/**
 * Phase 0 — analysis diagnostics: why the map looks the way it does.
 *
 * The classified raster alone cannot answer "is the whole area actually
 * analysed?" or "which pipeline stage ate my change pixels?". This module
 * derives those answers from data the pipeline already has (validity masks,
 * per-stage class rasters, kept-patch labels, index deltas) and ships them
 * in `CompareMetadata.diagnostics` for the Method & settings card and dev
 * logs. Pure maths — no network, no env.
 *
 * Coverage semantics (mutually exclusive, inside-polygon pixels only):
 *   analysed both dates → validA/validB/validBoth counts
 *   otherwise, first match wins:
 *     A missing (no acquisition) → B missing → cloud/shadow (acquired but
 *     rejected) → unknown (breakdown unavailable — synthetic fixtures).
 */
import { CLASS, MAGNITUDE_SCALE, type ScaledThresholds } from "./config";
import type { IndexRasters } from "./types";

/** Pixel counts per class code at one pipeline stage. */
export interface ClassCounts {
  noChange: number;
  vegGain: number;
  vegLoss: number;
  bareBuilt: number;
  waterGain: number;
  waterLoss: number;
  masked: number;
  outside: number;
  /** Sum of the five change classes (1-5) — the number each stage can lose. */
  change: number;
}

/** Counts every class code in one pass (256-slot histogram, then mapped). */
export function countClasses(grid: Uint8Array): ClassCounts {
  const t = new Uint32Array(256);
  for (let i = 0; i < grid.length; i++) t[grid[i]] += 1;
  return {
    noChange: t[CLASS.noChange],
    vegGain: t[CLASS.vegGain],
    vegLoss: t[CLASS.vegLoss],
    bareBuilt: t[CLASS.bareBuilt],
    waterGain: t[CLASS.waterGain],
    waterLoss: t[CLASS.waterLoss],
    masked: t[CLASS.masked],
    outside: t[CLASS.outside],
    change: t[CLASS.vegGain] + t[CLASS.vegLoss] + t[CLASS.bareBuilt] + t[CLASS.waterGain] + t[CLASS.waterLoss],
  };
}

/** Valid/missing breakdown over the analysed (inside-polygon) pixels. */
export interface CoverageDiagnostics {
  insidePixels: number;
  validAPixels: number;
  validBPixels: number;
  validBothPixels: number;
  aMissingPixels: number;
  bMissingPixels: number;
  cloudShadowPixels: number;
  unknownPixels: number;
  /** Percent of inside pixels (1 decimal). */
  validAPct: number;
  validBPct: number;
  validBothPct: number;
  aMissingPct: number;
  bMissingPct: number;
  cloudShadowPct: number;
  unknownPct: number;
}

export interface CoverageArgs {
  inside: Uint8Array;
  validA: Uint8Array;
  validB: Uint8Array;
  /** 1 where side A has no acquisition at the pixel (dataMask=0 / no orbit). */
  nodataA?: Uint8Array | null;
  nodataB?: Uint8Array | null;
  /** 1 where the side was acquired but rejected (cloud/shadow/SCL gate). */
  cloudyA?: Uint8Array | null;
  cloudyB?: Uint8Array | null;
}

/** Per-side missing/cloud flags for the v2 composite QC bands. Absent bands
 *  (synthetic fixtures) → both null, so unexplained invalid pixels land in the
 *  honest "unknown" bucket instead of being guessed. */
export function compositeSideFlags(parsed: {
  valid: Uint8Array;
  cloudyObs?: Float32Array;
  nodataObs?: Float32Array;
}): { nodata: Uint8Array | null; cloudy: Uint8Array | null } {
  if (!parsed.cloudyObs || !parsed.nodataObs) return { nodata: null, cloudy: null };
  const n = parsed.valid.length;
  const nodata = new Uint8Array(n);
  const cloudy = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (parsed.valid[i] === 1) continue;
    // Any acquisition rejected by the cloud/SCL gate → cloud (a clean revisit
    // could help); otherwise the window held no usable acquisition → missing.
    if (parsed.cloudyObs[i] > 0) cloudy[i] = 1;
    else nodata[i] = 1;
  }
  return { nodata, cloudy };
}

/** Per-side flags for the v1 single-date raster (dataMask + SCL validity).
 *  Missing `nodata` (synthetic fixtures) → both null = unknown bucket. */
export function singleSideFlags(
  valid: Uint8Array,
  nodata: Uint8Array | null,
): { nodata: Uint8Array | null; cloudy: Uint8Array | null } {
  if (!nodata) return { nodata: null, cloudy: null };
  const cloudy = new Uint8Array(valid.length);
  for (let i = 0; i < valid.length; i++) {
    cloudy[i] = valid[i] === 0 && nodata[i] === 0 ? 1 : 0;
  }
  return { nodata, cloudy };
}

function pct(count: number, total: number): number {
  return total === 0 ? 0 : Math.round((count / total) * 1000) / 10;
}

/** Coverage breakdown over inside pixels (pre-dilation — what the user's
 *  polygon area actually had to work with). */
export function computeCoverage(args: CoverageArgs): CoverageDiagnostics {
  const { inside, validA, validB } = args;
  let insidePixels = 0;
  let validAPixels = 0;
  let validBPixels = 0;
  let validBothPixels = 0;
  let aMissingPixels = 0;
  let bMissingPixels = 0;
  let cloudShadowPixels = 0;
  let unknownPixels = 0;

  for (let i = 0; i < inside.length; i++) {
    if (inside[i] !== 1) continue;
    insidePixels += 1;
    const aOk = validA[i] === 1;
    const bOk = validB[i] === 1;
    if (aOk) validAPixels += 1;
    if (bOk) validBPixels += 1;
    if (aOk && bOk) {
      validBothPixels += 1;
      continue;
    }
    // Precedence: A missing → B missing → cloud/shadow → unknown.
    if (args.nodataA?.[i] === 1) aMissingPixels += 1;
    else if (args.nodataB?.[i] === 1) bMissingPixels += 1;
    else if (args.cloudyA?.[i] === 1 || args.cloudyB?.[i] === 1) cloudShadowPixels += 1;
    else unknownPixels += 1;
  }

  return {
    insidePixels,
    validAPixels,
    validBPixels,
    validBothPixels,
    aMissingPixels,
    bMissingPixels,
    cloudShadowPixels,
    unknownPixels,
    validAPct: pct(validAPixels, insidePixels),
    validBPct: pct(validBPixels, insidePixels),
    validBothPct: pct(validBothPixels, insidePixels),
    aMissingPct: pct(aMissingPixels, insidePixels),
    bMissingPct: pct(bMissingPixels, insidePixels),
    cloudShadowPct: pct(cloudShadowPixels, insidePixels),
    unknownPct: pct(unknownPixels, insidePixels),
  };
}

/**
 * Phase 1 — per-pixel coverage reason raster (the map version of the
 * coverage breakdown above). Same precedence, plus `outside` for pixels
 * outside the polygon so the layer can be rendered from one buffer:
 *   0 analysed (valid on both dates) · 1 A missing · 2 B missing
 *   3 cloud/shadow · 4 unknown · 5 outside the polygon
 */
export const COVERAGE_REASON = {
  analysed: 0,
  aMissing: 1,
  bMissing: 2,
  cloud: 3,
  unknown: 4,
  outside: 5,
} as const;

export function coverageReasonRaster(args: CoverageArgs): Uint8Array {
  const { inside, validA, validB } = args;
  const out = new Uint8Array(inside.length);
  for (let i = 0; i < inside.length; i++) {
    if (inside[i] !== 1) {
      out[i] = COVERAGE_REASON.outside;
      continue;
    }
    if (validA[i] === 1 && validB[i] === 1) {
      out[i] = COVERAGE_REASON.analysed;
      continue;
    }
    if (args.nodataA?.[i] === 1) out[i] = COVERAGE_REASON.aMissing;
    else if (args.nodataB?.[i] === 1) out[i] = COVERAGE_REASON.bMissing;
    else if (args.cloudyA?.[i] === 1 || args.cloudyB?.[i] === 1) out[i] = COVERAGE_REASON.cloud;
    else out[i] = COVERAGE_REASON.unknown;
  }
  return out;
}

/** Phase 1 — Δ-index magnitude planes (int8, MAGNITUDE_SCALE) for the map's
 *  magnitude layer: one signed plane per index plus a combined plane holding
 *  the strongest |Δ| in threshold units (sign of the dominant index). */
export interface MagnitudePlanes {
  ndvi: Int8Array;
  mndwi: Int8Array;
  ndbi: Int8Array;
  combined: Int8Array;
}

function quantiseDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  return Math.max(-127, Math.min(127, Math.round(delta * MAGNITUDE_SCALE)));
}

export function magnitudePlanes(
  idxA: IndexRasters,
  idxB: IndexRasters,
  t: ScaledThresholds,
): MagnitudePlanes {
  const n = idxA.ndvi.length;
  const ndvi = new Int8Array(n);
  const mndwi = new Int8Array(n);
  const ndbi = new Int8Array(n);
  const combined = new Int8Array(n);
  // Representative threshold per index (largest applied gate = weakest change
  // the classifier could accept), so 1.0 on the combined plane ≈ "threshold".
  const tN = Math.max(Math.abs(t.vegLossD), Math.abs(t.vegGainD)) || 1e-6;
  const tW = Math.max(Math.abs(t.waterLossD), Math.abs(t.waterGainD)) || 1e-6;
  const tB = Math.abs(t.bareBuiltD) || 1e-6;
  for (let i = 0; i < n; i++) {
    const dN = idxB.ndvi[i] - idxA.ndvi[i];
    const dW = idxB.mndwi[i] - idxA.mndwi[i];
    const dB = idxB.ndbi[i] - idxA.ndbi[i];
    ndvi[i] = quantiseDelta(dN);
    mndwi[i] = quantiseDelta(dW);
    ndbi[i] = quantiseDelta(dB);
    const r1 = Math.abs(dN) / tN;
    const r2 = Math.abs(dW) / tW;
    const r3 = Math.abs(dB) / tB;
    let dominant = r1;
    let sign = dN;
    if (r2 > dominant) {
      dominant = r2;
      sign = dW;
    }
    if (r3 > dominant) {
      dominant = r3;
      sign = dB;
    }
    combined[i] = quantiseDelta(sign >= 0 ? dominant : -dominant);
  }
  return { ndvi, mndwi, ndbi, combined };
}

/** 1 where an inside pixel lies within `radius` (Chebyshev) of a non-inside
 *  pixel — polygon-boundary proximity for the edge-event flag. */
export function edgeProximityMask(
  inside: Uint8Array,
  width: number,
  height: number,
  radius = 2,
): Uint8Array {
  const out = new Uint8Array(inside.length);
  for (let i = 0; i < inside.length; i++) {
    if (inside[i] === 1) continue;
    const row = Math.floor(i / width);
    const col = i - row * width;
    const r0 = Math.max(0, row - radius);
    const r1 = Math.min(height - 1, row + radius);
    const c0 = Math.max(0, col - radius);
    const c1 = Math.min(width - 1, col + radius);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const j = r * width + c;
        if (inside[j] === 1) out[j] = 1;
      }
    }
  }
  return out;
}

/**
 * Phase 2 — per-pixel edge flag for events: 1 where an analysable pixel
 * touches (8-neighbour) the eroded polygon boundary, a masked pixel, or a
 * gap-fill source seam. Patches carrying any flagged pixel are marked
 * "edge, check" and excluded from headline totals unless the user opts in.
 */
export function edgeEventMask(
  insideClass: Uint8Array,
  valid: Uint8Array,
  gapSource: Uint8Array | null,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(insideClass.length);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      if (insideClass[i] !== 1) continue;
      const src = gapSource ? gapSource[i] : 0;
      let edge = false;
      for (let dr = -1; dr <= 1 && !edge; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || r >= height || c < 0 || c >= width) {
            edge = true;
            break;
          }
          const j = r * width + c;
          if (insideClass[j] !== 1 || valid[j] !== 1) {
            edge = true;
            break;
          }
          if (gapSource && gapSource[j] !== src) {
            edge = true;
            break;
          }
        }
      }
      out[i] = edge ? 1 : 0;
    }
  }
  return out;
}

/** Kept-patch size distribution + boundary proximity (Phase 0 edge report). */
export interface PatchDiagnostics {
  kept: number;
  /** Patches erased by the minimum-mapping-unit cutoff. */
  removed: number;
  sizeBuckets: Array<{ label: string; count: number }>;
  /** Kept patches with ≥1 pixel within 2 px of the polygon boundary. */
  edgeNear: number;
  /** edgeNear / kept (0-1). */
  edgeNearShare: number;
}

/** Fixed patch-size buckets in pixels (spec: counts by size). */
const SIZE_BUCKETS: Array<{ label: string; min: number; max: number | null }> = [
  { label: "1 px", min: 1, max: 1 },
  { label: "2-4 px", min: 2, max: 4 },
  { label: "5-9 px", min: 5, max: 9 },
  { label: "10-19 px", min: 10, max: 19 },
  { label: "20-49 px", min: 20, max: 49 },
  { label: "50-99 px", min: 50, max: 99 },
  { label: "100+ px", min: 100, max: null },
];

export function patchDiagnostics(
  labels: Int32Array,
  edge: Uint8Array,
  removed: number,
): PatchDiagnostics {
  const sizes = new Map<number, number>();
  const edgeSet = new Set<number>();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === 0) continue;
    sizes.set(label, (sizes.get(label) ?? 0) + 1);
    if (edge[i] === 1) edgeSet.add(label);
  }
  const sizeBuckets = SIZE_BUCKETS.map((bucket) => ({ label: bucket.label, count: 0 }));
  for (const size of sizes.values()) {
    const index = SIZE_BUCKETS.findIndex(
      (bucket) => size >= bucket.min && (bucket.max === null || size <= bucket.max),
    );
    if (index >= 0) sizeBuckets[index].count += 1;
  }
  const kept = sizes.size;
  return {
    kept,
    removed,
    sizeBuckets,
    edgeNear: edgeSet.size,
    edgeNearShare: kept === 0 ? 0 : edgeSet.size / kept,
  };
}

/** Δ-index histogram over the analysed pixels: `binCount` equal bins on
 *  [min, max] with the applied threshold lines to draw against. */
export interface DeltaHistogram {
  bins: number[];
  min: number;
  max: number;
  binCount: number;
  /** Applied Δ thresholds (post-sensitivity/adaptive scaling). */
  thresholds: number[];
}

export const HISTOGRAM_BINS = 40;
export const HISTOGRAM_MIN = -1;
export const HISTOGRAM_MAX = 1;

/** Counts b - a per analysed pixel into fixed bins (values clamped to the
 *  range; no delta array is materialised). */
export function deltaHistogram(
  a: Float32Array,
  b: Float32Array,
  mask: Uint8Array,
  thresholds: number[],
): DeltaHistogram {
  const bins = new Array<number>(HISTOGRAM_BINS).fill(0);
  const span = HISTOGRAM_MAX - HISTOGRAM_MIN;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    let d = b[i] - a[i];
    if (!Number.isFinite(d)) continue;
    if (d < HISTOGRAM_MIN) d = HISTOGRAM_MIN;
    if (d > HISTOGRAM_MAX) d = HISTOGRAM_MAX;
    let index = Math.floor(((d - HISTOGRAM_MIN) / span) * HISTOGRAM_BINS);
    if (index >= HISTOGRAM_BINS) index = HISTOGRAM_BINS - 1;
    if (index < 0) index = 0;
    bins[index] += 1;
  }
  return {
    bins,
    min: HISTOGRAM_MIN,
    max: HISTOGRAM_MAX,
    binCount: HISTOGRAM_BINS,
    thresholds,
  };
}

/** Threshold lines per index (the Δ gates the classifier actually used). */
export function histogramThresholds(t: ScaledThresholds): {
  ndvi: number[];
  mndwi: number[];
  ndbi: number[];
} {
  return {
    ndvi: [t.vegLossD, t.vegGainD],
    mndwi: [t.waterLossD, t.waterGainD],
    ndbi: [t.bareBuiltD],
  };
}

/** Full Phase 0 diagnostics blob attached to CompareMetadata. */
export interface CompareDiagnostics {
  grid: { width: number; height: number; metersPerPixel: number };
  coverage: CoverageDiagnostics;
  /** Class pixel counts at the three pipeline stages. */
  stages: { raw: ClassCounts; majority: ClassCounts; minPatch: ClassCounts };
  /** Pixels absorbed by the speckle-hole fill (adds change between stages). */
  holesFilled: number;
  patches: PatchDiagnostics;
  histograms: { ndvi: DeltaHistogram; mndwi: DeltaHistogram; ndbi: DeltaHistogram };
}
