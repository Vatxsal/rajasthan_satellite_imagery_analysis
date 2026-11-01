/** Robust statistics helpers for the v2 engine (median / MAD). */

/** Median of a copy-sorted numeric array (empty → 0). */
export function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = Array.from(values as ArrayLike<number>).sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median of an already-sorted array (odd/even conventions of `median`). */
export function medianSorted(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >> 1;
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Median absolute deviation. */
export function mad(values: ArrayLike<number>, center: number): number {
  const devs = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) devs[i] = Math.abs(values[i] - center);
  devs.sort((a, b) => a - b);
  return medianSorted(devs);
}

/** 1.4826 × MAD — a Gaussian-consistent robust σ estimate. */
export function robustSigma(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  const med = median(values);
  return 1.4826 * mad(values, med);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Stride that samples at most ~`target` pixels of an n-length raster. */
export function sampleStride(n: number, target: number): number {
  return Math.max(1, Math.floor(Math.sqrt(n / target)));
}
