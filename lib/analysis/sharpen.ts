/**
 * SHARPEN_SWIR — regression-based sharpening of the 20 m SWIR bands
 * (B11/B12) using the 10 m optical/NIR bands as predictors.
 *
 * Sentinel-2 SWIR is natively 20 m; the composite ships it bicubic-upsampled
 * onto the 10 m grid, so every index that reads B11/B12 (NDBI, MNDWI, BSI,
 * AWEI, NBR) is spatially soft. For each target band we:
 *
 *   1. fit a linear model AT THE 20 m EFFECTIVE SCALE — 2×2 box means of the
 *      five 10 m predictors (B02/B03/B04/B05/B08) vs the observed target,
 *      least squares over valid pixels (normal equations, 6×6);
 *   2. re-apply the fitted model at full 10 m resolution;
 *   3. add back ONLY its high-frequency residual —
 *      detail = pred − blockUp(box2(pred)) — to the observation.
 *
 * Means are preserved (the detail has zero mean per 2×2 block); only spatial
 * detail changes. Guards: near-constant targets/predictors and poor fits
 * (R² < SHARPEN_MIN_R2) leave the band untouched, and the added detail is
 * clamped to ±SHARPEN_DETAIL_CLAMP reflectance units so an ill-conditioned
 * fit can never blow up a pixel.
 *
 * Opt-in via env SHARPEN_SWIR (default off): it changes classification
 * inputs (NDBI/MNDWI/BSI), so the compare cache key carries the flag.
 * Recent-orbit indices arrive pre-computed from the evalscript and are NOT
 * sharpened (documented asymmetry — persistence compares signs, which a
 * mean-preserving filter does not flip).
 */
import type { CompositeBands } from "./composite";

export interface SharpenResult {
  /** R² of the 20 m-scale fit; 0 when the fit was skipped. */
  r2: number;
  /** True when the fitted detail was added to the band. */
  applied: boolean;
}

/** Fits below this R² would add mostly noise — leave the band untouched. */
export const SHARPEN_MIN_R2 = 0.3;
/** Hard cap on the added detail (reflectance units). */
export const SHARPEN_DETAIL_CLAMP = 0.2;
/** Max 20 m cells used for the least-squares fit (stride subsampling). */
const MAX_FIT_CELLS = 100_000;

const PREDICTORS: ReadonlyArray<keyof CompositeBands> = ["b02", "b03", "b04", "b05", "b08"];

/** 2×2 box means on a ceil grid; edge cells average the available samples. */
function boxMean2(
  src: Float32Array,
  w: number,
  h: number,
): { grid: Float32Array; gw: number; gh: number } {
  const gw = (w + 1) >> 1;
  const gh = (h + 1) >> 1;
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let sum = 0;
      let cnt = 0;
      for (let dy = 0; dy < 2; dy++) {
        const y = gy * 2 + dy;
        if (y >= h) continue;
        for (let dx = 0; dx < 2; dx++) {
          const x = gx * 2 + dx;
          if (x >= w) continue;
          sum += src[y * w + x];
          cnt += 1;
        }
      }
      grid[gy * gw + gx] = cnt === 0 ? 0 : sum / cnt;
    }
  }
  return { grid, gw, gh };
}

/** Each pixel takes its 2×2 cell's mean (block upsample of the box grid). */
function blockUp(box: Float32Array, gw: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = (y >> 1) * gw;
    for (let x = 0; x < w; x++) {
      out[y * w + x] = box[row + (x >> 1)];
    }
  }
  return out;
}

/** Gaussian elimination with partial pivoting; null when singular. */
function solve(matrix: number[][], rhs: number[]): number[] | null {
  const m = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    }
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    if (piv !== col) {
      const t = a[piv];
      a[piv] = a[col];
      a[col] = t;
    }
    for (let r = col + 1; r < m; r++) {
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c <= m; c++) a[r][c] -= f * a[col][c];
    }
  }
  const x = new Array<number>(m).fill(0);
  for (let r = m - 1; r >= 0; r--) {
    let s = a[r][m];
    for (let c = r + 1; c < m; c++) s -= a[r][c] * x[c];
    x[r] = s / a[r][r];
  }
  return x;
}

/** Least-squares fit of target ≈ c0 + Σci·predi on 20 m box-mean cells. */
function fitAt20m(
  target: Float32Array,
  preds: Float32Array[],
  valid: Uint8Array | null,
  w: number,
  h: number,
): { coeffs: number[]; r2: number } | null {
  const tBox = boxMean2(target, w, h);
  const pBoxes = preds.map((p) => boxMean2(p, w, h));
  const { gw, gh } = tBox;
  const m = preds.length + 1;

  const S = Array.from({ length: m }, () => new Array<number>(m).fill(0));
  const rhs = new Array<number>(m).fill(0);
  const cells = gw * gh;
  const stride = Math.max(1, Math.floor(cells / MAX_FIT_CELLS));
  // Sampled design rows for the R² pass (cap × m numbers).
  const xs: number[] = [];
  const ys: number[] = [];
  for (let cy = 0; cy < gh; cy++) {
    for (let cx = 0; cx < gw; cx++) {
      const ci = cy * gw + cx;
      if (ci % stride !== 0) continue;
      if (valid) {
        const y0 = Math.min(cy * 2, h - 1);
        const x0 = Math.min(cx * 2, w - 1);
        if (valid[y0 * w + x0] !== 1) continue;
      }
      const y = tBox.grid[ci];
      const row = new Array<number>(m);
      row[0] = 1;
      for (let p = 0; p < preds.length; p++) row[p + 1] = pBoxes[p].grid[ci];
      for (let i = 0; i < m; i++) {
        for (let j = 0; j < m; j++) S[i][j] += row[i] * row[j];
        rhs[i] += row[i] * y;
      }
      xs.push(...row);
      ys.push(y);
    }
  }
  const count = ys.length;
  if (count < m + 8) return null;
  const coeffs = solve(S, rhs);
  if (!coeffs) return null;

  let meanY = 0;
  for (const y of ys) meanY += y;
  meanY /= count;
  let ssRes = 0;
  let ssTot = 0;
  for (let k = 0; k < count; k++) {
    let yh = 0;
    for (let j = 0; j < m; j++) yh += coeffs[j] * xs[k * m + j];
    const r = ys[k] - yh;
    ssRes += r * r;
    const d = ys[k] - meanY;
    ssTot += d * d;
  }
  if (ssTot <= 1e-12) return null;
  const r2 = 1 - ssRes / ssTot;
  if (r2 < SHARPEN_MIN_R2) return null;
  return { coeffs, r2 };
}

/** Fits + applies one target band in place; no-op when the fit is unusable. */
function sharpenBand(
  target: Float32Array,
  preds: Float32Array[],
  valid: Uint8Array | null,
  w: number,
  h: number,
): SharpenResult {
  const fit = fitAt20m(target, preds, valid, w, h);
  if (!fit) return { r2: 0, applied: false };
  const n = w * h;
  const pred = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = fit.coeffs[0];
    for (let p = 0; p < preds.length; p++) v += fit.coeffs[p + 1] * preds[p][i];
    pred[i] = v;
  }
  const predBox = boxMean2(pred, w, h);
  const smooth = blockUp(predBox.grid, predBox.gw, w, h);
  for (let i = 0; i < n; i++) {
    let d = pred[i] - smooth[i];
    if (d > SHARPEN_DETAIL_CLAMP) d = SHARPEN_DETAIL_CLAMP;
    else if (d < -SHARPEN_DETAIL_CLAMP) d = -SHARPEN_DETAIL_CLAMP;
    target[i] += d;
  }
  return { r2: fit.r2, applied: true };
}

/**
 * Sharpens B11 and B12 of one composite side in place.
 * `valid` restricts the fit samples (1 = usable pixel); application is
 * everywhere — masked pixels are discarded by the classifier anyway.
 */
export function sharpenSwir(
  bands: CompositeBands,
  width: number,
  height: number,
  valid?: Uint8Array | null,
): { b11: SharpenResult; b12: SharpenResult } {
  const preds = PREDICTORS.map((k) => bands[k]);
  const v = valid ?? null;
  return {
    b11: sharpenBand(bands.b11, preds, v, width, height),
    b12: sharpenBand(bands.b12, preds, v, width, height),
  };
}
