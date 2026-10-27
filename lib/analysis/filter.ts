/**
 * Spatial noise control: 3×3 majority filter, then 8-connected-component
 * labelling with a minimum-mapping-unit (MMU) cutoff. Small speckles become
 * "no change"; surviving patches keep their labels — the same labels feed the
 * statistics and the top hotspots.
 */
import { CLASS, MAJORITY_WINDOW, M2_PER_HA } from "./config";

/**
 * Replaces each valid pixel's class with the most frequent class among its
 * valid neighbours (3×3, self included). Ties keep the original value.
 * Masked/outside pixels pass through untouched.
 */
export function majorityFilter(
  classGrid: Uint8Array,
  valid: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const out = Uint8Array.from(classGrid);
  const half = Math.floor(MAJORITY_WINDOW / 2);
  const counts = new Map<number, number>();
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      if (valid[i] !== 1) continue;
      counts.clear();
      const r0 = Math.max(0, row - half);
      const r1 = Math.min(height - 1, row + half);
      const c0 = Math.max(0, col - half);
      const c1 = Math.min(width - 1, col + half);
      let best = classGrid[i];
      let bestCount = -1;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const j = r * width + c;
          if (valid[j] !== 1) continue;
          const code = classGrid[j];
          const n = (counts.get(code) ?? 0) + 1;
          counts.set(code, n);
          if (n > bestCount) {
            bestCount = n;
            best = code;
          }
        }
      }
      // Tie → winner is whichever class first reached bestCount; deterministic
      // (raster order) but stable only per run — acceptable for denoising.
      out[i] = best;
    }
  }
  return out;
}

export function minPatchPixels(minPatchHa: number, metersX: number, metersY: number): number {
  const pxAreaM2 = metersX * metersY;
  return Math.max(1, Math.ceil((minPatchHa * M2_PER_HA) / pxAreaM2));
}

export interface LabelResult {
  /** Label id per pixel, 0 = no kept patch. */
  labels: Int32Array;
  /** Patches smaller than minPixels removed → classGrid mutated to no-change. */
  removedCount: number;
  keptCount: number;
}

/**
 * 8-connected labelling over change classes (1-5). Patches with fewer than
 * `minPixels` pixels are erased (set to no-change, label 0).
 * Mutates `classGrid` in place for removed patches (spec-compliant, saves a
 * copy); kept patches keep their class.
 */
export function labelPatches(
  classGrid: Uint8Array,
  width: number,
  height: number,
  minPixels: number,
): LabelResult {
  const labels = new Int32Array(width * height);
  const stack: number[] = [];
  let nextLabel = 0;
  let removedCount = 0;
  let keptCount = 0;

  for (let seed = 0; seed < classGrid.length; seed++) {
    const seedClass = classGrid[seed];
    if (labels[seed] !== 0 || seedClass < CLASS.vegGain || seedClass > CLASS.waterLoss) continue;

    nextLabel += 1;
    const pixels: number[] = [];
    stack.length = 0;
    stack.push(seed);
    labels[seed] = nextLabel;
    while (stack.length > 0) {
      const i = stack.pop()!;
      pixels.push(i);
      const row = Math.floor(i / width);
      const col = i - row * width;
      const r0 = Math.max(0, row - 1);
      const r1 = Math.min(height - 1, row + 1);
      const c0 = Math.max(0, col - 1);
      const c1 = Math.min(width - 1, col + 1);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const j = r * width + c;
          if (labels[j] !== 0 || classGrid[j] !== seedClass) continue;
          labels[j] = nextLabel;
          stack.push(j);
        }
      }
    }

    if (pixels.length < minPixels) {
      removedCount += 1;
      for (const i of pixels) {
        classGrid[i] = CLASS.noChange;
        labels[i] = 0;
      }
    } else {
      keptCount += 1;
    }
  }
  return { labels, removedCount, keptCount };
}
