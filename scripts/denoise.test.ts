import assert from "node:assert/strict";
import test from "node:test";
import { CLASS } from "../lib/analysis/config";
import { fillSmallHoles, labelPatches, majorityFilter } from "../lib/analysis/filter";

function full(size: number, value: number): Uint8Array {
  return new Uint8Array(size).fill(value);
}

test("majorityFilter: passes=2 equals two sequential single passes, kills speckles", () => {
  const W = 7;
  const H = 7;
  const n = W * H;
  const valid = full(n, 1);
  const g = full(n, CLASS.noChange);
  g[3 * W + 3] = CLASS.vegLoss; // isolated speckle

  const twoPass = majorityFilter(g, valid, W, H, 2);
  assert.equal(twoPass[3 * W + 3], CLASS.noChange, "speckle gone");

  const chained = majorityFilter(majorityFilter(g, valid, W, H, 1), valid, W, H, 1);
  assert.deepEqual(Array.from(twoPass), Array.from(chained), "passes=2 == filter(filter())");

  const onePass = majorityFilter(g, valid, W, H);
  assert.deepEqual(Array.from(onePass), Array.from(majorityFilter(g, valid, W, H, 1)), "default = 1 pass");
});

test("fillSmallHoles: absorbs a 1-px hole inside one patch, barriers win", () => {
  const W = 9;
  const H = 9;
  const n = W * H;
  const valid = full(n, 1);
  const g = full(n, CLASS.noChange);
  const setBlock = (r0: number, r1: number, c0: number, c1: number, cls: number): void => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) g[r * W + c] = cls;
  };
  setBlock(2, 6, 2, 6, CLASS.vegLoss); // 5×5 patch
  g[4 * W + 4] = CLASS.noChange; // 1-px hole

  const filled = fillSmallHoles(g, valid, W, H, 4);
  assert.equal(filled, 1);
  assert.equal(g[4 * W + 4], CLASS.vegLoss, "hole absorbed into the surrounding patch");

  // Same hole but its neighbour is masked → cloud gaps are never filled.
  const g2 = full(n, CLASS.noChange);
  for (let r = 2; r <= 6; r++) for (let c = 2; c <= 6; c++) g2[r * W + c] = CLASS.vegLoss;
  g2[4 * W + 4] = CLASS.noChange;
  g2[4 * W + 5] = CLASS.masked;
  const valid2 = Uint8Array.from(valid);
  valid2[4 * W + 5] = 0;
  assert.equal(fillSmallHoles(g2, valid2, W, H, 4), 0, "masked barrier → untouched");
  assert.equal(g2[4 * W + 4], CLASS.noChange);

  // Holes touching invalid data (outside the polygon) are also left alone.
  const g3 = full(n, CLASS.noChange);
  for (let r = 1; r <= 5; r++) for (let c = 0; c <= 4; c++) g3[r * W + c] = CLASS.waterGain;
  g3[3 * W + 4] = CLASS.noChange; // touches col 5 → outside/invalid
  const valid3 = full(n, 1);
  valid3[3 * W + 5] = 0;
  assert.equal(fillSmallHoles(g3, valid3, W, H, 4), 0);
  assert.equal(g3[3 * W + 4], CLASS.noChange);

  // Oversized interior void (> maxHolePx) is real structure, not speckle.
  const g4 = full(n, CLASS.noChange);
  for (let r = 1; r <= 7; r++) for (let c = 1; c <= 7; c++) g4[r * W + c] = CLASS.vegLoss;
  for (let r = 3; r <= 5; r++) for (let c = 3; c <= 5; c++) g4[r * W + c] = CLASS.noChange; // 9 px
  assert.equal(fillSmallHoles(g4, full(n, 1), W, H, 4), 0, "9 px hole > 4 px budget");
});

test("labelPatches: confidence-aware MMU keeps strong sub-MMU patches (v2)", () => {
  const W = 10;
  const H = 10;
  const g = new Uint8Array(W * H);
  const pixels: number[] = [];
  for (let r = 4; r <= 5; r++) {
    for (let c = 2; c <= 6; c++) {
      const i = r * W + c;
      g[i] = CLASS.vegLoss;
      pixels.push(i);
    }
  }
  assert.equal(pixels.length, 10);
  const minPixels = 20; // patch is below MMU

  // v1 (no tiers): strict erasure.
  const strict = Uint8Array.from(g);
  const r1 = labelPatches(strict, W, H, minPixels);
  assert.equal(r1.keptCount, 0);
  assert.equal(strict[4 * W + 2], CLASS.noChange, "erased to no-change");

  // v2, all-high tiers: kept (10 ≥ 0.5×20, high share 100% ≥ 40%).
  const highTiers = new Uint8Array(W * H).fill(3);
  const keepGrid = Uint8Array.from(g);
  const r2 = labelPatches(keepGrid, W, H, minPixels, highTiers);
  assert.equal(r2.keptCount, 1);
  assert.equal(keepGrid[4 * W + 2], CLASS.vegLoss, "high-confidence patch survives");
  assert.ok(r2.labels[4 * W + 2] > 0);

  // v2, low tiers: still erased (no high-confidence support).
  const lowTiers = new Uint8Array(W * H).fill(1);
  const eraseGrid = Uint8Array.from(g);
  const r3 = labelPatches(eraseGrid, W, H, minPixels, lowTiers);
  assert.equal(r3.keptCount, 0);
  assert.equal(eraseGrid[4 * W + 2], CLASS.noChange);

  // Below 0.5×MMU: even all-high tiers cannot rescue it.
  const tiny = new Uint8Array(W * H);
  tiny[4 * W + 4] = CLASS.vegLoss;
  const r4 = labelPatches(tiny, W, H, minPixels, highTiers);
  assert.equal(r4.keptCount, 0, "1 px < minKeep(10)");
});
