/**
 * Pixel-wise change classification + validity grid construction.
 *
 * Precedence (spec order — first match wins per pixel):
 *   water gain → water loss → vegetation loss → vegetation gain → bare/built
 *   → no change. Masked pixels are decided earlier (validity), never here.
 */
import { CLASS, type ScaledThresholds } from "./config";
import type { IndexRasters } from "./types";

/** 1 where the pixel is analysable in both dates (inside polygon, both valid). */
export function combineValidity(
  validA: Uint8Array,
  validB: Uint8Array,
  inside: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(validA.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = validA[i] === 1 && validB[i] === 1 && inside[i] === 1 ? 1 : 0;
  }
  return out;
}

/**
 * Dilates invalidity by one pixel (morphological erosion of the valid mask):
 * a valid pixel bordering invalid data is dropped, so cloud edges and scene
 * borders do not bleed false positives into the change map.
 */
export function dilateInvalid(valid: Uint8Array, width: number, height: number): Uint8Array {
  const out = Uint8Array.from(valid);
  // Seed = ORIGINALLY invalid pixels only (read from `valid`), so the halo
  // stays exactly 1 px — no cascading erosion from freshly-killed pixels.
  for (let i = 0; i < valid.length; i++) {
    if (valid[i] === 1) continue;
    const row = Math.floor(i / width);
    const col = i - row * width;
    const r0 = Math.max(0, row - 1);
    const r1 = Math.min(height - 1, row + 1);
    const c0 = Math.max(0, col - 1);
    const c1 = Math.min(width - 1, col + 1);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) out[r * width + c] = 0;
    }
  }
  return out;
}

/**
 * Classifies one pixel. `valid` = combined validity (post-dilation).
 * Returns a CLASS code 0-5, CLASS.masked or CLASS.outside.
 */
export function classifyPixel(
  a: IndexRasters,
  b: IndexRasters,
  i: number,
  valid: Uint8Array,
  inside: Uint8Array,
  t: ScaledThresholds,
): number {
  if (inside[i] !== 1) return CLASS.outside;
  if (valid[i] !== 1) return CLASS.masked;

  const dNdvi = b.ndvi[i] - a.ndvi[i];
  const dMndwi = b.mndwi[i] - a.mndwi[i];
  const dNdbi = b.ndbi[i] - a.ndbi[i];

  // 1. Water gain: index swung positive AND the after-date is open water.
  if (dMndwi >= t.waterGainD && b.mndwi[i] > 0) return CLASS.waterGain;
  // 2. Water loss: index swung negative AND the before-date was open water.
  if (dMndwi <= t.waterLossD && a.mndwi[i] > 0) return CLASS.waterLoss;
  // 3. Vegetation loss / 4. vegetation gain.
  if (dNdvi <= t.vegLossD) return CLASS.vegLoss;
  if (dNdvi >= t.vegGainD) return CLASS.vegGain;
  // 5. Bare / built-up: SWIR rise with simultaneous green-down, not water.
  if (
    dNdbi >= t.bareBuiltD &&
    dNdvi <= t.bareBuiltNdviMax &&
    a.mndwi[i] <= t.bareBuiltMaxMndwi &&
    b.mndwi[i] <= t.bareBuiltMaxMndwi
  ) {
    return CLASS.bareBuilt;
  }
  return CLASS.noChange;
}

/** Classifies the whole grid in one pass. */
export function classifyChange(
  a: IndexRasters,
  b: IndexRasters,
  valid: Uint8Array,
  inside: Uint8Array,
  t: ScaledThresholds,
): Uint8Array {
  const out = new Uint8Array(valid.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = classifyPixel(a, b, i, valid, inside, t);
  }
  return out;
}
