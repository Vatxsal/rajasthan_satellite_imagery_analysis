/**
 * Spatial noise control: 2 passes of the 3×3 majority filter, small-hole
 * filling, then 8-connected-component labelling with a minimum-mapping-unit
 * (MMU) cutoff. Small speckles become "no change"; surviving patches keep
 * their labels — the same labels feed the statistics and the top hotspots.
 * (Phase 3, audit weaknesses #11/#12.)
 */
import {
  CLASS,
  MAJORITY_WINDOW,
  M2_PER_HA,
  MMU_CONFIDENCE_HIGH_SHARE,
  MMU_CONFIDENCE_SIZE_FACTOR,
} from "./config";

/**
 * Replaces each valid pixel's class with the most frequent class among its
 * valid neighbours (3×3, self included). Ties keep the original value.
 * Masked/outside pixels pass through untouched. `passes` > 1 re-filters the
 * previous output (salt-and-pepper needs the second pass; the operation is
 * near-idempotent so extra passes cost little and erode nothing further).
 */
export function majorityFilter(
  classGrid: Uint8Array,
  valid: Uint8Array,
  width: number,
  height: number,
  passes = 1,
): Uint8Array {
  let current = Uint8Array.from(classGrid);
  for (let pass = 0; pass < Math.max(1, passes); pass++) {
    const source = current;
    const out = Uint8Array.from(source);
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
        let best = source[i];
        let bestCount = -1;
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const j = r * width + c;
            if (valid[j] !== 1) continue;
            const code = source[j];
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
    current = out;
  }
  return current;
}

/**
 * Fills no-change pockets (≤ maxHolePx, 4-connected) that sit inside a single
 * change class and touch no masked/outside pixel — speckle holes that would
 * otherwise become tiny hole rings in the vectorised polygons (Phase 3).
 * Returns the number of pixels absorbed into their surrounding patch.
 */
export function fillSmallHoles(
  classGrid: Uint8Array,
  valid: Uint8Array,
  width: number,
  height: number,
  maxHolePx: number,
): number {
  if (maxHolePx <= 0) return 0;
  const n = classGrid.length;
  const visited = new Uint8Array(n);
  const stack: number[] = [];
  const component: number[] = [];
  let filled = 0;
  const classSet = new Set<number>();

  for (let seed = 0; seed < n; seed++) {
    if (visited[seed] === 1 || valid[seed] !== 1 || classGrid[seed] !== CLASS.noChange) continue;
    component.length = 0;
    classSet.clear();
    visited[seed] = 1;
    stack.length = 0;
    stack.push(seed);
    let touchesBarrier = false;
    while (stack.length > 0) {
      const i = stack.pop()!;
      component.push(i);
      const row = Math.floor(i / width);
      const col = i - row * width;
      const neighbours = [
        row > 0 ? i - width : -1,
        row < height - 1 ? i + width : -1,
        col > 0 ? i - 1 : -1,
        col < width - 1 ? i + 1 : -1,
      ];
      for (const j of neighbours) {
        if (j < 0) {
          touchesBarrier = true;
          continue;
        }
        if (valid[j] !== 1) {
          touchesBarrier = true;
          continue;
        }
        if (classGrid[j] === CLASS.noChange) {
          if (visited[j] !== 1) {
            visited[j] = 1;
            stack.push(j);
          }
        } else if (classGrid[j] !== CLASS.outside) {
          classSet.add(classGrid[j]);
        } else {
          touchesBarrier = true;
        }
      }
    }
    if (touchesBarrier || classSet.size !== 1 || component.length > maxHolePx) continue;
    const target = classSet.values().next().value as number;
    for (const i of component) {
      classGrid[i] = target;
      filled += 1;
    }
  }
  return filled;
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
 * `minPixels` pixels are erased (set to no-change, label 0) — unless `tiers`
 * is given (engine v2): a patch at ≥ MMU_CONFIDENCE_SIZE_FACTOR × MMU whose
 * pixels are ≥ MMU_CONFIDENCE_HIGH_SHARE high-confidence is real but small
 * (a pond, a cleared plot) and survives (Phase 3, weakness #11).
 * Mutates `classGrid` in place for removed patches (spec-compliant, saves a
 * copy); kept patches keep their class.
 */
export function labelPatches(
  classGrid: Uint8Array,
  width: number,
  height: number,
  minPixels: number,
  tiers?: Uint8Array | null,
): LabelResult {
  const labels = new Int32Array(width * height);
  const stack: number[] = [];
  let nextLabel = 0;
  let removedCount = 0;
  let keptCount = 0;
  const minKeep = Math.max(1, Math.ceil(minPixels * MMU_CONFIDENCE_SIZE_FACTOR));
  const highThreshold = Math.ceil(MMU_CONFIDENCE_HIGH_SHARE * minKeep);

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

    let kept = pixels.length >= minPixels;
    if (!kept && tiers && pixels.length >= minKeep) {
      let high = 0;
      for (const i of pixels) if (tiers[i] === 3) high += 1;
      kept = high >= highThreshold;
    }
    if (!kept) {
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
