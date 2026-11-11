/**
 * Cropping-pattern logic (Phase 2): the 12-month agri-year calendar, NDVI
 * series shaping, the classification rules, field zonal statistics over the
 * analysis grid, the PU estimate, and deterministic k-means grouping.
 *
 * Pure functions only — no `next/server`, no env, no network. The route
 * (app/api/fields/pattern) wires guards/caching/streaming around runPattern
 * (lib/fields/patternRun.ts), which composes these pieces.
 *
 * What this module deliberately does NOT do: name crop species. The rules
 * read only the seasonal shape of an NDVI curve, so every class is a
 * cropping *pattern* (kharif/rabi/double/zaid/fallow/evergreen) and
 * `unclassified` is the safety fallback.
 */
import { bboxFromGeometry, computeOutputSize } from "@/lib/cdse/geometry";
import { GRID_MIN_PX } from "@/lib/analysis/config";
import { makeAnalysisGrid, nativeLongSidePx } from "@/lib/analysis/grid";
import { rasterizeAreaMask } from "@/lib/analysis/mask";
import { estimateRenderPu, NDVI_MONTH_INPUT_BANDS } from "@/lib/analysis/pu";
import type { AnalysisGrid } from "@/lib/analysis/types";
import type { BBox } from "@/lib/data";
import {
  PATTERN_DOUBLE_CROP_DIP,
  PATTERN_EVERGREEN_MIN,
  PATTERN_GROUPING_ITERS,
  PATTERN_GROUPING_K,
  PATTERN_GROUPING_MIN_FIELDS,
  PATTERN_GROUPING_SAMPLE,
  PATTERN_GREEN_MIN,
  PATTERN_MAX_PX,
  PATTERN_MIN_VALID_MONTHS,
  PATTERN_MONTH_COUNT,
  PATTERN_MONTH_SAMPLES,
  PATTERN_SEASONS,
  PATTERN_SMOOTH_WINDOW,
  PATTERN_ZAID_PEAK_MONTHS,
  type PatternClass,
} from "./config";

/** Duck-typed contract error understood by lib/server/api errorResponse(). */
export function patternError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

// ── Agri-year calendar ──────────────────────────────────────────────────────

export interface PatternMonth {
  index: number;
  /** `YYYY-MM` of the calendar month (echoed in the stream frames). */
  label: string;
  from: string;
  to: string;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The 12 months of one agri year starting in June of `year` and ending in
 * May of `year + 1` — Rajasthan's kharif/rabi/zaid calendar (index 0 = Jun …
 * index 6 = Dec of `year`, index 7 = Jan … index 11 = May of `year + 1`).
 * Ranges are UTC day bounds, matching the Process API timeRange format.
 */
export function agriYearMonths(year: number): PatternMonth[] {
  const months: PatternMonth[] = [];
  for (let index = 0; index < PATTERN_MONTH_COUNT; index++) {
    const monthNum = (5 + index) % 12; // 0-based: 5 = June of `year`
    const yearOf = index <= 6 ? year : year + 1;
    const mm = String(monthNum + 1).padStart(2, "0");
    const days = monthNum === 1 && isLeapYear(yearOf) ? 29 : MONTH_DAYS[monthNum];
    const dd = String(days).padStart(2, "0");
    months.push({
      index,
      label: `${yearOf}-${mm}`,
      from: `${yearOf}-${mm}-01T00:00:00Z`,
      to: `${yearOf}-${mm}-${dd}T23:59:59Z`,
    });
  }
  return months;
}

// ── Series shaping ──────────────────────────────────────────────────────────

/**
 * Fills `null` months (no valid pixels) in the observed curve: linear
 * interpolation across interior gaps, nearest known value at both edges,
 * and `null` only when the whole series is missing.
 */
export function gapFill(series: Array<number | null>): number[] | null {
  const n = series.length;
  const known: number[] = [];
  for (let i = 0; i < n; i++) if (series[i] !== null) known.push(i);
  if (known.length === 0) return null;

  const first = known[0];
  const last = known[known.length - 1];
  const out = new Array<number>(n);
  for (let i = 0; i < first; i++) out[i] = series[first] as number;
  for (let i = first; i <= last; i++) {
    const value = series[i];
    if (value !== null) {
      out[i] = value;
      continue;
    }
    let prev = first;
    let next = last;
    for (const k of known) {
      if (k < i) prev = k;
      else {
        next = k;
        break;
      }
    }
    const a = series[prev] as number;
    const b = series[next] as number;
    out[i] = a + ((b - a) * (i - prev)) / (next - prev);
  }
  for (let i = last + 1; i < n; i++) out[i] = series[last] as number;
  return out;
}

/**
 * Centred moving average over PATTERN_SMOOTH_WINDOW months (shipped window:
 * 3 → edges average the two available neighbours). Only the two-peak test
 * reads the smoothed copy — every shipped number comes from the gap-filled
 * series.
 */
export function smooth3(series: number[]): number[] {
  const n = series.length;
  if (n === 0) return [];
  const radius = Math.floor(PATTERN_SMOOTH_WINDOW / 2);
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let k = i - radius; k <= i + radius; k++) {
      if (k < 0 || k >= n) continue;
      sum += series[k];
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

// ── Metrics & classification ────────────────────────────────────────────────

export interface PatternMetrics {
  mean: number;
  min: number;
  max: number;
  /** First index attaining `max` (ties → earliest month). */
  peakMonth: number;
  greenMonths: number;
  kharifMean: number;
  rabiMean: number;
  zaidMean: number;
}

function windowMean(series: number[], indices: readonly number[]): number {
  let sum = 0;
  for (const index of indices) sum += series[index];
  return sum / indices.length;
}

/** Summary statistics of a gap-filled series (all shipped numbers derive here). */
export function seriesMetrics(raw: number[]): PatternMetrics {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let maxIndex = 0;
  let greenMonths = 0;
  for (let i = 0; i < raw.length; i++) {
    const value = raw[i];
    sum += value;
    if (value < min) min = value;
    if (value > max) {
      max = value;
      maxIndex = i;
    }
    if (value >= PATTERN_GREEN_MIN) greenMonths++;
  }
  return {
    mean: sum / raw.length,
    min,
    max,
    peakMonth: maxIndex,
    greenMonths,
    kharifMean: windowMean(raw, PATTERN_SEASONS.kharif),
    rabiMean: windowMean(raw, PATTERN_SEASONS.rabi),
    zaidMean: windowMean(raw, PATTERN_SEASONS.zaid),
  };
}

/**
 * Local maxima of the smoothed series whose value still counts as green.
 * Edges treat the missing neighbour as −∞, so a monotonic rise/fall reports
 * its boundary month once; plateaus report their first index.
 */
function localPeaks(series: number[]): number[] {
  const peaks: number[] = [];
  for (let i = 0; i < series.length; i++) {
    const left = i > 0 ? series[i - 1] : -Infinity;
    const right = i < series.length - 1 ? series[i + 1] : -Infinity;
    if (series[i] > left && series[i] >= right && series[i] >= PATTERN_GREEN_MIN) {
      peaks.push(i);
    }
  }
  return peaks;
}

/** Two green peaks separated by a dip of at least PATTERN_DOUBLE_CROP_DIP. */
function hasDoubleCropDip(smoothed: number[]): boolean {
  const peaks = localPeaks(smoothed);
  for (let p = 1; p < peaks.length; p++) {
    const from = peaks[p - 1];
    const to = peaks[p];
    let valley = Infinity;
    for (let i = from; i <= to; i++) if (smoothed[i] < valley) valley = smoothed[i];
    if (valley <= Math.min(smoothed[from], smoothed[to]) - PATTERN_DOUBLE_CROP_DIP) {
      return true;
    }
  }
  return false;
}

/**
 * The rule order (evaluated top to bottom; `unclassified` is assigned
 * upstream when fewer than PATTERN_MIN_VALID_MONTHS months were observed):
 *
 *   1. max < GREEN_MIN            → fallow (nothing grew)
 *   2. min ≥ EVERGREEN_MIN        → evergreen (green every month)
 *   3. two peaks with a deep dip  → double-cropped (smoothed curve only)
 *   4. peakMonth ∈ {Apr, May}     → zaid (summer crop)
 *   5. kharifMean ≥ rabiMean      → kharif-only
 *   6. otherwise                  → rabi-only
 *
 * Thresholds/metrics come from the gap-filled series; only step 3 reads the
 * smoothed copy (single-month noise must not fake a second peak).
 */
export function classifySeries(smoothed: number[], metrics: PatternMetrics): PatternClass {
  if (metrics.max < PATTERN_GREEN_MIN) return "fallow";
  if (metrics.min >= PATTERN_EVERGREEN_MIN) return "evergreen";
  if (hasDoubleCropDip(smoothed)) return "double-cropped";
  if ((PATTERN_ZAID_PEAK_MONTHS as readonly number[]).includes(metrics.peakMonth)) return "zaid";
  if (metrics.kharifMean >= metrics.rabiMean) return "kharif-only";
  return "rabi-only";
}

/** True when a series has enough observed months to be classified at all. */
export function classifiable(validMonths: number): boolean {
  return validMonths >= PATTERN_MIN_VALID_MONTHS;
}

// ── Zonal statistics on the analysis grid ───────────────────────────────────

/**
 * Rasterizes every field polygon onto the grid as zone tags (feature index +
 * 1, 0 = outside). Each field is rendered into the window of pixels its own
 * bbox covers — a 1024² grid with 3000 fields must not allocate 3000 full
 * grids (rasterizeZones would). First-wins on shared edges, so results are
 * deterministic. Int32 (not Int16) tags: FIELDS_MAX_COUNT is env-tunable
 * past 32 767.
 */
export function rasterizeFieldZones(
  features: ReadonlyArray<GeoJSON.Feature<GeoJSON.Polygon | GeoJSON.MultiPolygon>>,
  grid: AnalysisGrid,
): Int32Array {
  const { width, height, bbox, pxLon, pxLat } = grid;
  const west = bbox[0];
  const east = bbox[2];
  const south = bbox[1];
  const north = bbox[3];
  const out = new Int32Array(width * height);

  features.forEach((feature, index) => {
    const featureBbox = bboxFromGeometry(feature.geometry);
    if (!featureBbox) return;
    const [fWest, fSouth, fEast, fNorth] = featureBbox;
    if (fEast < west || fWest > east || fNorth < south || fSouth > north) return;

    const col0 = Math.max(0, Math.floor((fWest - west) / pxLon));
    const col1 = Math.min(width - 1, Math.ceil((fEast - west) / pxLon) - 1);
    const row0 = Math.max(0, Math.floor((north - fNorth) / pxLat));
    const row1 = Math.min(height - 1, Math.ceil((north - fSouth) / pxLat) - 1);
    if (col0 > col1 || row0 > row1) return;

    const subBbox: BBox = [
      west + col0 * pxLon,
      north - (row1 + 1) * pxLat,
      west + (col1 + 1) * pxLon,
      north - row0 * pxLat,
    ];
    const subGrid = makeAnalysisGrid(subBbox, col1 - col0 + 1, row1 - row0 + 1);
    const mask = rasterizeAreaMask(feature.geometry, subGrid);
    const tag = index + 1;
    for (let row = 0; row < subGrid.height; row++) {
      const src = row * subGrid.width;
      const dst = (row0 + row) * width + col0;
      for (let col = 0; col < subGrid.width; col++) {
        if (mask[src + col] === 1 && out[dst + col] === 0) out[dst + col] = tag;
      }
    }
  });
  return out;
}

export interface ZonalRaster {
  width: number;
  height: number;
  ndvi: Float32Array;
  valid: Uint8Array;
}

/** Mean NDVI per zone over the valid pixels of one month (null = no pixels). */
export function zonalMonthlyMeans(
  zones: Int32Array,
  raster: ZonalRaster,
  zoneCount: number,
): Array<number | null> {
  const sums = new Float64Array(zoneCount);
  const counts = new Uint32Array(zoneCount);
  const pixels = Math.min(zones.length, raster.ndvi.length, raster.valid.length);
  for (let i = 0; i < pixels; i++) {
    const tag = zones[i];
    if (tag <= 0 || tag > zoneCount) continue;
    if (raster.valid[i] !== 1) continue;
    sums[tag - 1] += raster.ndvi[i];
    counts[tag - 1] += 1;
  }
  const out: Array<number | null> = new Array(zoneCount);
  for (let z = 0; z < zoneCount; z++) {
    out[z] = counts[z] > 0 ? sums[z] / counts[z] : null;
  }
  return out;
}

// ── Grid & cost ─────────────────────────────────────────────────────────────

/**
 * Pattern grid for a selection: native 10 m resolution (so field pixels are
 * honest) capped at PATTERN_MAX_PX long side and floored at GRID_MIN_PX —
 * a long thin ≤25 km² bbox would otherwise ask for tens of thousands of
 * columns and blow the PU budget.
 */
export function preparePatternGrid(bbox: BBox, maxPx: number = PATTERN_MAX_PX): AnalysisGrid {
  const cap = Math.max(GRID_MIN_PX, Math.min(maxPx, Math.floor(nativeLongSidePx(bbox))));
  const { width, height } = computeOutputSize(bbox, cap);
  return makeAnalysisGrid(bbox, width, height);
}

/**
 * PU of the whole run = 12 monthly FLOAT32 renders at the pattern grid size
 * (dataMask excluded from the band count — see lib/analysis/pu.ts). A
 * 25 km² selection lands near 183 PU, well under PER_ANALYSIS_PU_LIMIT.
 */
export function estimatePatternPu(size: { width: number; height: number }): number {
  return (
    estimateRenderPu({
      width: size.width,
      height: size.height,
      inputBands: NDVI_MONTH_INPUT_BANDS,
      float: true,
      samples: PATTERN_MONTH_SAMPLES,
    }) * PATTERN_MONTH_COUNT
  );
}

// ── Deterministic k-means grouping ──────────────────────────────────────────

export interface PatternGrouping {
  k: number;
  /** Cluster index per input series (relabelled by ascending centroid mean). */
  labels: number[];
}

function distance2(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

/** Deterministic stride sample: every `ceil(n / cap)`-th index, capped at `cap`. */
function strideSample(n: number, cap: number): number[] {
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const step = Math.ceil(n / cap);
  const sample: number[] = [];
  for (let i = 0; i < n; i += step) sample.push(i);
  return sample;
}

/**
 * Lloyd's algorithm with farthest-point seeding (no RNG — the same input
 * always yields the same labels): c0 = farthest from the mean, each next
 * centre = point farthest from its nearest existing centre. Assignment ties
 * go to the lowest cluster; an emptied cluster steals the point farthest
 * from its current centroid. Stops when labels stop changing.
 */
function kmeans(
  points: number[][],
  k: number,
  iterations: number,
): { labels: number[]; centroids: number[][] } | null {
  const n = points.length;
  if (n === 0 || k < 2 || k >= n) return null;
  const dim = points[0].length;

  const mean = new Array<number>(dim).fill(0);
  for (const point of points) for (let d = 0; d < dim; d++) mean[d] += point[d];
  for (let d = 0; d < dim; d++) mean[d] /= n;

  const centroids: number[][] = [];
  const chosen = new Set<number>();
  let seed = 0;
  let seedDistance = -1;
  for (let i = 0; i < n; i++) {
    const d = distance2(points[i], mean);
    if (d > seedDistance) {
      seedDistance = d;
      seed = i;
    }
  }
  centroids.push([...points[seed]]);
  chosen.add(seed);
  while (centroids.length < k) {
    let bestIndex = -1;
    let bestDistance = -1;
    for (let i = 0; i < n; i++) {
      if (chosen.has(i)) continue;
      let nearest = Infinity;
      for (const centre of centroids) {
        const d = distance2(points[i], centre);
        if (d < nearest) nearest = d;
      }
      if (nearest > bestDistance) {
        bestDistance = nearest;
        bestIndex = i;
      }
    }
    if (bestIndex === -1) return null;
    centroids.push([...points[bestIndex]]);
    chosen.add(bestIndex);
  }

  const labels = new Array<number>(n).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    const previous = labels.slice();

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        const d = distance2(points[i], centroids[c]);
        if (d < bestDistance) {
          bestDistance = d;
          best = c;
        }
      }
      labels[i] = best;
    }

    for (let guard = 0; guard < k; guard++) {
      const counts = new Array<number>(k).fill(0);
      for (const label of labels) counts[label] += 1;
      const empty = counts.indexOf(0);
      if (empty === -1) break;
      let steal = -1;
      let stealDistance = -1;
      for (let i = 0; i < n; i++) {
        if (counts[labels[i]] <= 1) continue; // never empty a second cluster
        const d = distance2(points[i], centroids[labels[i]]);
        if (d > stealDistance) {
          stealDistance = d;
          steal = i;
        }
      }
      if (steal === -1) break;
      counts[labels[steal]] -= 1;
      labels[steal] = empty;
      counts[empty] += 1;
    }

    const sums = Array.from({ length: k }, () => new Array<number>(dim).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const label = labels[i];
      counts[label] += 1;
      for (let d = 0; d < dim; d++) sums[label][d] += points[i][d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue;
      for (let d = 0; d < dim; d++) centroids[c][d] = sums[c][d] / counts[c];
    }

    let changed = false;
    for (let i = 0; i < n; i++) if (labels[i] !== previous[i]) changed = true;
    if (!changed) break;
  }

  return { labels, centroids };
}

/**
 * Mean silhouette of a stride sample against ALL points (a(i) and b(i) use
 * the full dataset, per the classic definition). Singleton clusters score 0;
 * identical points (denominator 0) score 0 rather than NaN.
 */
function meanSilhouette(points: number[][], labels: number[], sample: number[], k: number): number {
  const n = points.length;
  let total = 0;
  for (const i of sample) {
    const own = labels[i];
    let ownSum = 0;
    let ownCount = 0;
    const otherSum = new Array<number>(k).fill(0);
    const otherCount = new Array<number>(k).fill(0);
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = Math.sqrt(distance2(points[i], points[j]));
      if (labels[j] === own) {
        ownSum += d;
        ownCount++;
      } else {
        otherSum[labels[j]] += d;
        otherCount[labels[j]] += 1;
      }
    }
    if (ownCount === 0) continue; // singleton → s = 0
    const a = ownSum / ownCount;
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || otherCount[c] === 0) continue;
      const m = otherSum[c] / otherCount[c];
      if (m < b) b = m;
    }
    if (!Number.isFinite(b)) continue;
    const denominator = Math.max(a, b);
    total += denominator === 0 ? 0 : (b - a) / denominator;
  }
  return total / sample.length;
}

/**
 * Groups gap-filled field curves with deterministic k-means: k ∈
 * PATTERN_GROUPING_K chosen by silhouette on a stride sample, ties → the
 * smaller k (candidates iterate ascending, replacement is strictly greater).
 * Returns null (grouping off) below the minimum field count, when no k beats
 * a silhouette of 0 (all-identical / no structure), or when the sample sees
 * fewer than two clusters.
 */
export function groupSeries(series: number[][]): PatternGrouping | null {
  const n = series.length;
  if (n < PATTERN_GROUPING_MIN_FIELDS) return null;
  const sample = strideSample(n, PATTERN_GROUPING_SAMPLE);

  let best: { k: number; labels: number[]; centroids: number[][]; score: number } | null = null;
  for (const k of PATTERN_GROUPING_K) {
    if (k >= n) continue;
    const run = kmeans(series, k, PATTERN_GROUPING_ITERS);
    if (!run) continue;
    const score = meanSilhouette(series, run.labels, sample, k);
    if (best === null || score > best.score) {
      best = { k, labels: run.labels, centroids: run.centroids, score };
    }
  }
  if (!best || best.score <= 0) return null;
  const picked = best;

  const seen = new Set(sample.map((index) => picked.labels[index]));
  if (seen.size < 2) return null;

  // Relabel clusters by ascending centroid mean so group ids read low→high.
  const order = picked.centroids
    .map((centre, index) => ({
      index,
      mean: centre.reduce((sum, value) => sum + value, 0) / centre.length,
    }))
    .sort((a, b) => a.mean - b.mean || a.index - b.index);
  const remap = new Map<number, number>();
  order.forEach((entry, rank) => remap.set(entry.index, rank));
  return { k: picked.k, labels: picked.labels.map((label) => remap.get(label) ?? 0) };
}
