/**
 * Phase 2.4 — adaptive thresholds.
 *
 * The base thresholds (config.ts) are tuned for "typical" seasonal noise; a
 * real pair can be much noisier (monsoon clouds, phenology) or cleaner. The
 * robust σ of each Δ-index over the valid pixels rescales that index's Δ
 * thresholds, clamped to [0.7, 1.5] so adaptation can never invert intent.
 *
 * Every effective value is echoed in the result metadata (#17) — including
 * the state gates that were previously computed but never reported.
 */
import {
  ADAPTIVE_SCALE_MAX,
  ADAPTIVE_SCALE_MIN,
  V2_REFERENCE_SIGMA,
  type ScaledThresholds,
} from "../config";
import { clamp, robustSigma, sampleStride } from "./math";
import type { V2Indices } from "./indices";

const SAMPLE_TARGET = 40_000;
const MIN_SAMPLES = 100;

export interface AdaptiveThresholds {
  /** Effective thresholds (base × sensitivity × adaptive scale). */
  t: ScaledThresholds;
  /** Applied scale per Δ-index (metadata). */
  scales: Record<string, number>;
  /** Robust σ per Δ-index (metadata). */
  sigma: Record<string, number>;
}

/**
 * Computes effective thresholds from the A→B deltas of `valid` pixels.
 * State gates (mndwi minima, maxMndwi) are NOT scaled — they are absolute
 * spectral positions, not noise margins.
 */
export function adaptiveThresholds(
  a: V2Indices,
  b: V2Indices,
  valid: Uint8Array,
  base: ScaledThresholds,
): AdaptiveThresholds {
  const n = valid.length;
  const step = sampleStride(n, SAMPLE_TARGET);
  const dNdvi: number[] = [];
  const dMndwi: number[] = [];
  const dNdbi: number[] = [];
  const dBsi: number[] = [];
  for (let i = 0; i < n; i += step) {
    if (valid[i] !== 1) continue;
    dNdvi.push(b.ndvi[i] - a.ndvi[i]);
    dMndwi.push(b.mndwi[i] - a.mndwi[i]);
    dNdbi.push(b.ndbi[i] - a.ndbi[i]);
    dBsi.push(b.bsi[i] - a.bsi[i]);
  }

  const sigma: Record<string, number> = { ndvi: 0, mndwi: 0, ndbi: 0, bsi: 0 };
  const scales: Record<string, number> = { ndvi: 1, mndwi: 1, ndbi: 1, bsi: 1 };
  if (dNdvi.length >= MIN_SAMPLES) {
    const samples: Record<string, number[]> = {
      ndvi: dNdvi,
      mndwi: dMndwi,
      ndbi: dNdbi,
      bsi: dBsi,
    };
    for (const key of Object.keys(V2_REFERENCE_SIGMA)) {
      const ref = V2_REFERENCE_SIGMA[key];
      const s = robustSigma(samples[key]);
      sigma[key] = s;
      scales[key] = clamp(s / ref, ADAPTIVE_SCALE_MIN, ADAPTIVE_SCALE_MAX);
    }
  }

  const t: ScaledThresholds = {
    waterGainD: base.waterGainD * scales.mndwi,
    waterLossD: base.waterLossD * scales.mndwi,
    vegLossD: base.vegLossD * scales.ndvi,
    vegGainD: base.vegGainD * scales.ndvi,
    bareBuiltD: base.bareBuiltD * scales.ndbi,
    bareBuiltNdviMax: base.bareBuiltNdviMax * scales.ndvi,
    bareBuiltMaxMndwi: base.bareBuiltMaxMndwi,
    waterGainMndwiMin: base.waterGainMndwiMin,
    waterLossMndwiMin: base.waterLossMndwiMin,
  };
  return { t, scales, sigma };
}
