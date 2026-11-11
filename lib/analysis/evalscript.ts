/**
 * Evalscript for change analysis: 5-band FLOAT32 raster (ORBIT mosaicking,
 * L2A) per date. Indices are computed on the server so both dates come back
 * as plain numerics — no 8-bit quantisation of difference signals.
 *
 * Bands: 1 NDVI · 2 MNDWI · 3 NDBI · 4 VALID (SCL) · 5 dataMask.
 * Nodata → 0 in every band; VALID=0 distinguishes "no data" from real 0s.
 */
import { COMPOSITE_MAX_CLOUD_PROB } from "./config";

const HEADER = "//VERSION=3\n";

/** SCL classes excluded from VALID (mirrors config.ts EXCLUDED_SCL). */
const EXCLUDED_SCL = [0, 1, 3, 8, 9, 10, 11];

export const COMPARE_EVALSCRIPT = `${HEADER}function setup() {
  return {
    input: [{ bands: ["B03", "B04", "B08", "B11", "SCL", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 5, sampleType: "FLOAT32" },
  };
}
var excluded = ${JSON.stringify(EXCLUDED_SCL)};
function isValid(scl) {
  // Math.round: bilinear resampling can return fractional SCL values — strict
  // equality against the exclusion list would silently keep cloud pixels (#18).
  var cls = Math.round(scl);
  for (var i = 0; i < excluded.length; i++) {
    if (cls === excluded[i]) return 0;
  }
  return 1;
}
function evaluatePixel(samples) {
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (s.dataMask === 1) {
      var ndviDen = s.B08 + s.B04;
      var mndwiDen = s.B03 + s.B11;
      var ndbiDen = s.B11 + s.B08;
      var ndvi = ndviDen === 0 ? 0 : (s.B08 - s.B04) / ndviDen;
      var mndwi = mndwiDen === 0 ? 0 : (s.B03 - s.B11) / mndwiDen;
      var ndbi = ndbiDen === 0 ? 0 : (s.B11 - s.B08) / ndbiDen;
      return [ndvi, mndwi, ndbi, isValid(s.SCL), 1];
    }
  }
  return [0, 0, 0, 0, 0];
}`;

/**
 * Engine-v2 composite input: per-pixel median of every valid orbit in the
 * ±COMPOSITE_WINDOW_DAYS timeRange (ORBIT mosaicking — one sample per
 * overpass, mosaicked across tiles), so a cloudy anchor date falls back to
 * neighbouring days instead of voiding the pixel.
 *
 * Valid sample = dataMask ∧ SCL ∉ excluded ∧ CLD ≤ 30 (Sen2Cor cloud %).
 * 12 FLOAT32 bands: B02 B03 B04 B05 B08 B11 B12 · valid_obs_count · recent SCL
 * · recent-orbit NDVI/MNDWI/NDBI (most-recent valid sample in the window —
 * drives the Phase 2.7 persistence check; outputs are PU-free).
 * Nodata → all zeros (count 0 = invalid). Indices are derived client-side
 * (lib/analysis/composite.ts) with the exact v1 formulas for A/B parity.
 */
export const COMPARE_EVALSCRIPT_COMPOSITE = `${HEADER}function setup() {
  return {
    input: [
      { bands: ["B02", "B03", "B04", "B05", "B08", "B11", "B12", "SCL", "CLD", "dataMask"] },
    ],
    mosaicking: "ORBIT",
    output: { bands: 12, sampleType: "FLOAT32", mosaickingOrder: "mostRecent" },
  };
}
var excluded = ${JSON.stringify(EXCLUDED_SCL)};
var maxCloudProb = ${COMPOSITE_MAX_CLOUD_PROB};
function isValidSample(s) {
  if (s.dataMask !== 1) return 0;
  var scl = Math.round(s.SCL);
  for (var i = 0; i < excluded.length; i++) {
    if (scl === excluded[i]) return 0;
  }
  if (s.CLD > maxCloudProb) return 0;
  return 1;
}
function median(values) {
  values.sort(function (a, b) { return a - b; });
  var mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
function ndviOf(s) { var d = s.B08 + s.B04; return d === 0 ? 0 : (s.B08 - s.B04) / d; }
function mndwiOf(s) { var d = s.B03 + s.B11; return d === 0 ? 0 : (s.B03 - s.B11) / d; }
function ndbiOf(s) { var d = s.B11 + s.B08; return d === 0 ? 0 : (s.B11 - s.B08) / d; }
function evaluatePixel(samples) {
  var acc = [[], [], [], [], [], [], []];
  var count = 0;
  var recentScl = 0;
  var recent = null;
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (!isValidSample(s)) continue;
    // samples are ordered most-recent first → the first valid = recent orbit
    if (count === 0) { recentScl = Math.round(s.SCL); recent = s; }
    acc[0].push(s.B02);
    acc[1].push(s.B03);
    acc[2].push(s.B04);
    acc[3].push(s.B05);
    acc[4].push(s.B08);
    acc[5].push(s.B11);
    acc[6].push(s.B12);
    count++;
  }
  if (count === 0) return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  return [
    median(acc[0]), median(acc[1]), median(acc[2]), median(acc[3]),
    median(acc[4]), median(acc[5]), median(acc[6]), count, recentScl,
    ndviOf(recent), mndwiOf(recent), ndbiOf(recent),
  ];
}`;

/**
 * Phase-2 monthly NDVI input: ONE render per agri-year month (a month-long
 * timeRange, ORBIT mosaicking) returning a 2-band FLOAT32 raster:
 *
 *   1 NDVI — median of every valid orbit in the month
 *   2 VALID — 1 when ≥ 1 orbit contributed, else 0
 *
 * Valid sample = dataMask ∧ SCL ∉ excluded ∧ CLD ≤ COMPOSITE_MAX_CLOUD_PROB
 * (same gate as the engine-v2 composite). An all-cloud month returns
 * [0, 0] — VALID=0 distinguishes "no observation" from a real NDVI of 0.
 * Field zonal means are then computed client-side per month
 * (lib/fields/pattern.ts zonalMonthlyMeans).
 */
export const NDVI_MONTH_EVALSCRIPT = `${HEADER}function setup() {
  return {
    input: [{ bands: ["B04", "B08", "SCL", "CLD", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 2, sampleType: "FLOAT32" },
  };
}
var excluded = ${JSON.stringify(EXCLUDED_SCL)};
var maxCloudProb = ${COMPOSITE_MAX_CLOUD_PROB};
function isValidSample(s) {
  if (s.dataMask !== 1) return 0;
  var cls = Math.round(s.SCL);
  for (var i = 0; i < excluded.length; i++) {
    if (cls === excluded[i]) return 0;
  }
  if (s.CLD > maxCloudProb) return 0;
  return 1;
}
function evaluatePixel(samples) {
  var ndvi = [];
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (!isValidSample(s)) continue;
    var den = s.B08 + s.B04;
    ndvi.push(den === 0 ? 0 : (s.B08 - s.B04) / den);
  }
  if (ndvi.length === 0) return [0, 0];
  ndvi.sort(function (a, b) { return a - b; });
  var mid = ndvi.length >> 1;
  var median = ndvi.length % 2 ? ndvi[mid] : (ndvi[mid - 1] + ndvi[mid]) / 2;
  return [median, 1];
}`;

/**
 * Sentinel-1 GRD input (Phase 1): per-pixel temporal median of every valid
 * acquisition in the ±S1_WINDOW_DAYS range, one orbit direction per side.
 * Bands: 1 median VV (linear power) · 2 median VH · 3 valid-observation count.
 *
 * Speckle reduction = temporal median here + built-in LEE 5×5 in the request
 * processing options (lib/analysis/s1.ts). dB conversion happens client-side
 * after the median (dB is monotonic, so dB(median(linear)) is the median of
 * the dB series up to even-sample averaging).
 *
 * Nodata conventions: dataMask=0 or VV/VH ≤ 0 (nodata renders as 0) → sample
 * skipped; count 0 = invalid pixel (mirrors the optical composite).
 */
export const S1_EVALSCRIPT = `${HEADER}function setup() {
  return {
    input: [{ bands: ["VV", "VH", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 3, sampleType: "FLOAT32" },
  };
}
function median(values) {
  values.sort(function (a, b) { return a - b; });
  var mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
function evaluatePixel(samples) {
  var vv = [], vh = [];
  for (var i = 0; i < samples.length; i++) {
    var s = samples[i];
    if (s.dataMask !== 1) continue;
    if (!(s.VV > 0) || !(s.VH > 0)) continue; // 0 = nodata
    vv.push(s.VV);
    vh.push(s.VH);
  }
  if (vv.length === 0) return [0, 0, 0];
  return [median(vv), median(vh), vv.length];
}`;
