import assert from "node:assert/strict";
import test from "node:test";
import { interpretProbe, PROBE_NEAR_MISS_SHARE, type ProbeInput } from "../lib/analysis/probe";
import { CLASS } from "../lib/analysis/config";

/** 8×8 window fixture — the verdict logic is size-generic. */
const W = 8;
const H = 8;
const N = W * H;
const CENTER = 4 * W + 4;

const THRESHOLDS = {
  vegLossDNdvi: -0.15,
  vegGainDNdvi: 0.15,
  waterLossDMndwi: -0.2,
  waterGainDMndwi: 0.2,
  bareBuiltDNdbi: 0.2,
};

function baseInput(overrides: Partial<ProbeInput> = {}): ProbeInput {
  return {
    classGrid: new Uint8Array(N),
    labels: new Int32Array(N),
    tiers: null,
    coverage: new Uint8Array(N),
    magnitude: {
      ndvi: new Int8Array(N),
      mndwi: new Int8Array(N),
      ndbi: new Int8Array(N),
    },
    thresholds: THRESHOLDS,
    width: W,
    height: H,
    pxAreaHa: 0.01,
    minPatchHa: 0.05,
    centerIdx: CENTER,
    ...overrides,
  };
}

test("probe: kept — the center patch survived the pipeline", () => {
  const classGrid = new Uint8Array(N).fill(CLASS.vegLoss);
  const labels = new Int32Array(N);
  // A 4-pixel kept patch (label 7) around the center.
  for (const idx of [CENTER, CENTER + 1, CENTER + W, CENTER + W + 1]) labels[idx] = 7;
  const tiers = new Uint8Array(N);
  tiers[CENTER] = 3;
  const result = interpretProbe(baseInput({ classGrid, labels, tiers }));
  assert.equal(result.verdict, "kept");
  assert.equal(result.classCode, CLASS.vegLoss);
  assert.equal(result.classLabel, "Vegetation loss");
  assert.equal(result.patchHa, 0.04); // 4 px × 0.01 ha
  assert.equal(result.confidence, "high");
  assert.equal(result.clipped, false);
});

test("probe: kept patch clipped when it touches the window edge", () => {
  const classGrid = new Uint8Array(N).fill(CLASS.vegGain);
  const labels = new Int32Array(N);
  labels[CENTER] = 3;
  labels[CENTER - W * 4] = 3; // row 0 — the top border
  const result = interpretProbe(baseInput({ classGrid, labels }));
  assert.equal(result.verdict, "kept");
  assert.equal(result.clipped, true, "border pixel → size is a lower bound");
});

test("probe: below-mmu — classified change cut by the minimum patch size", () => {
  const classGrid = new Uint8Array(N);
  // A 3-pixel vegGain component (0.03 ha) under a 0.05 ha MMU — label 0.
  classGrid[CENTER] = CLASS.vegGain;
  classGrid[CENTER + 1] = CLASS.vegGain;
  classGrid[CENTER + W] = CLASS.vegGain;
  const labels = new Int32Array(N); // nothing kept
  const result = interpretProbe(baseInput({ classGrid, labels }));
  assert.equal(result.verdict, "below-mmu");
  assert.equal(result.classCode, CLASS.vegGain);
  assert.equal(result.patchHa, 0.03);
  assert.equal(result.minPatchHa, 0.05);
  // A bigger component (0.08 ha) over the MMU stays consistent in shape.
  const bigGrid = new Uint8Array(N);
  const cells = [CENTER, CENTER + 1, CENTER + 2, CENTER + W, CENTER + W + 1, CENTER + W + 2, CENTER - W, CENTER - W + 1];
  for (const idx of cells) bigGrid[idx] = CLASS.vegGain;
  const bigResult = interpretProbe(baseInput({ classGrid: bigGrid, labels: new Int32Array(N) }));
  assert.equal(bigResult.verdict, "below-mmu");
  assert.equal(bigResult.patchHa, 0.08);
});

test("probe: below-mmu respects 4-connectivity (diagonals don't join)", () => {
  const classGrid = new Uint8Array(N);
  classGrid[CENTER] = CLASS.waterGain;
  classGrid[CENTER + 1 + W] = CLASS.waterGain; // diagonal only
  const result = interpretProbe(baseInput({ classGrid }));
  assert.equal(result.verdict, "below-mmu");
  assert.equal(result.patchHa, 0.01, "diagonal neighbour is a separate component");
});

test("probe: sub-threshold near miss reports the deltas", () => {
  const magnitude = {
    ndvi: new Int8Array(N),
    mndwi: new Int8Array(N),
    ndbi: new Int8Array(N),
  };
  // ΔNDVI −0.08 against a ±0.15 threshold → ratio 0.53 (a near miss).
  magnitude.ndvi[CENTER] = Math.round(-0.08 * 64);
  const result = interpretProbe(baseInput({ magnitude }));
  assert.equal(result.verdict, "sub-threshold");
  // int8 ×64 quantisation: allow half a step (1/128).
  assert.ok(Math.abs(result.deltas.ndvi + 0.08) < 1 / 128);
  assert.equal(result.classCode, null);
  assert.deepEqual(result.thresholds, THRESHOLDS);
  // The near-miss share is the boundary the verdict documents.
  assert.equal(PROBE_NEAR_MISS_SHARE, 0.5);
});

test("probe: quiet pixel → no-change", () => {
  const magnitude = {
    ndvi: new Int8Array(N),
    mndwi: new Int8Array(N),
    ndbi: new Int8Array(N),
  };
  magnitude.ndvi[CENTER] = Math.round(0.02 * 64); // ratio 0.13
  const result = interpretProbe(baseInput({ magnitude }));
  assert.equal(result.verdict, "no-change");
  assert.ok(Math.abs(result.deltas.ndvi - 0.02) < 1 / 128);
});

test("probe: masked with the coverage reason", () => {
  const classGrid = new Uint8Array(N);
  classGrid[CENTER] = CLASS.masked;
  const coverage = new Uint8Array(N);
  coverage[CENTER] = 3; // COVERAGE_REASON.cloud
  const result = interpretProbe(baseInput({ classGrid, coverage }));
  assert.equal(result.verdict, "masked");
  assert.equal(result.coverage, "cloud");
  // Date-B missing reports as b-missing.
  coverage[CENTER] = 2;
  assert.equal(interpretProbe(baseInput({ classGrid, coverage })).coverage, "b-missing");
  // Unknown reason stays honest.
  coverage[CENTER] = 4;
  assert.equal(interpretProbe(baseInput({ classGrid, coverage })).coverage, "unknown");
});
