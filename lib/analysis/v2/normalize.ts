/**
 * Phase 2.1 — radiometric normalisation of side A against side B.
 *
 * L2A is atmospherically corrected, so residual A↔B offsets are small (haze,
 * calibration drift) — but a seasonally shifted histogram would erase real
 * change, so the correction is deliberately conservative:
 *
 *   - additive median matching only (per band: shift = median(B) − median(A))
 *   - |raw shift| > NORMALIZE_SKIP → band skipped entirely (unmatchable)
 *   - |raw shift| ≤ NORMALIZE_CLAMP → applied as-is; in between → clamped
 *
 * Applied to A's reflectance bands in place, before index derivation.
 */
import { clamp, median, sampleStride } from "./math";

const SAMPLE_TARGET = 50_000;
/** Shifts larger than this are treated as seasonal signal, not calibration. */
export const NORMALIZE_SKIP = 0.08;
/** Hard cap on any applied shift (reflectance units). */
export const NORMALIZE_CLAMP = 0.04;

export interface BandSetLike {
  b02: Float32Array;
  b03: Float32Array;
  b04: Float32Array;
  b05: Float32Array;
  b08: Float32Array;
  b11: Float32Array;
  b12: Float32Array;
}

export interface NormalizeResult {
  appliedBands: number;
  skippedBands: number;
  /** Largest |shift| actually applied (metadata diagnostics). */
  maxShift: number;
}

/**
 * Mutates A's seven bands in place. `mask` = validA ∧ validB ∧ inside
 * (pre-dilation): only jointly-analysable pixels anchor the statistics.
 */
export function normalizeBands(
  a: BandSetLike,
  b: BandSetLike,
  mask: Uint8Array,
): NormalizeResult {
  const n = mask.length;
  const step = sampleStride(n, SAMPLE_TARGET);
  const bands: Array<[Float32Array, Float32Array]> = [
    [a.b02, b.b02],
    [a.b03, b.b03],
    [a.b04, b.b04],
    [a.b05, b.b05],
    [a.b08, b.b08],
    [a.b11, b.b11],
    [a.b12, b.b12],
  ];

  const result: NormalizeResult = { appliedBands: 0, skippedBands: 0, maxShift: 0 };
  for (const [av, bv] of bands) {
    const sa: number[] = [];
    const sb: number[] = [];
    for (let i = 0; i < n; i += step) {
      if (mask[i] !== 1) continue;
      sa.push(av[i]);
      sb.push(bv[i]);
    }
    if (sa.length < 100) {
      result.skippedBands += 1;
      continue;
    }
    const raw = median(sb) - median(sa);
    if (Math.abs(raw) > NORMALIZE_SKIP) {
      result.skippedBands += 1;
      continue;
    }
    const shift = clamp(raw, -NORMALIZE_CLAMP, NORMALIZE_CLAMP);
    if (shift !== 0) {
      for (let i = 0; i < n; i++) {
        if (mask[i] === 1) av[i] += shift;
      }
      result.appliedBands += 1;
      result.maxShift = Math.max(result.maxShift, Math.abs(shift));
    } else {
      // Medians already match — nothing to do, band counts as aligned.
      result.appliedBands += 1;
    }
  }
  return result;
}
