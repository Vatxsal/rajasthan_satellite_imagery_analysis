import assert from "node:assert/strict";
import test from "node:test";
import { CLASS } from "../lib/analysis/config";
import { makeAnalysisGrid } from "../lib/analysis/grid";
import { buildPatchVectors } from "../lib/analysis/stats";
import { TIER } from "../lib/analysis/v2/classify";

/** Phase 5 (#13) — full-coverage patch vector layer on the CompareArtifact. */

function gridFixture(): {
  grid: ReturnType<typeof makeAnalysisGrid>;
  classGrid: Uint8Array;
  labels: Int32Array;
} {
  const W = 8;
  const H = 6;
  const grid = makeAnalysisGrid([74.0, 26.0, 74.008, 26.006], W, H);
  const n = W * H;
  const classGrid = new Uint8Array(n);
  const labels = new Int32Array(n);
  // Patch 1: label 1, veg loss, 6 px (rows 1-2 × cols 1-3).
  for (let row = 1; row <= 2; row++) {
    for (let col = 1; col <= 3; col++) {
      const i = row * W + col;
      classGrid[i] = CLASS.vegLoss;
      labels[i] = 1;
    }
  }
  // Patch 2: label 2, water gain, 4 px (rows 3-4 × cols 5-6).
  for (let row = 3; row <= 4; row++) {
    for (let col = 5; col <= 6; col++) {
      const i = row * W + col;
      classGrid[i] = CLASS.waterGain;
      labels[i] = 2;
    }
  }
  return { grid, classGrid, labels };
}

const AUX_V1 = { tiers: null, subs: null, persist: null, shortGap: false };

test("buildPatchVectors: every kept patch becomes a feature with props", () => {
  const { grid, classGrid, labels } = gridFixture();
  const pxAreaHa = (grid.metersX * grid.metersY) / 10_000;
  const fc = buildPatchVectors(classGrid, labels, grid, pxAreaHa, AUX_V1);

  assert.equal(fc.type, "FeatureCollection");
  assert.equal(fc.features.length, 2, "both patches vectorized");

  const first = fc.features[0];
  assert.equal(first.geometry?.type, "MultiPolygon");
  const props = first.properties as Record<string, unknown>;
  assert.equal(props.classCode, CLASS.vegLoss);
  assert.equal(props.label, 1);
  assert.equal(props.classLabel, "Vegetation loss");
  assert.ok((props.areaHa as number) > 0);
  assert.ok(Array.isArray(props.centroid) && (props.centroid as number[]).length === 2);
  assert.equal("confidence" in props, false, "v1 (no tiers) carries no confidence");
});

test("buildPatchVectors: limit keeps the largest patches first", () => {
  const { grid, classGrid, labels } = gridFixture();
  const pxAreaHa = (grid.metersX * grid.metersY) / 10_000;

  const fc = buildPatchVectors(classGrid, labels, grid, pxAreaHa, AUX_V1, 1);
  assert.equal(fc.features.length, 1, "cap respected");
  assert.equal((fc.features[0].properties as Record<string, unknown>).label, 1, "largest kept");

  const empty = buildPatchVectors(new Uint8Array(48), new Int32Array(48), grid, pxAreaHa, AUX_V1);
  assert.equal(empty.features.length, 0, "no labels → empty collection");
});

test("buildPatchVectors: v2 majority confidence tier rides on the props", () => {
  const { grid, classGrid, labels } = gridFixture();
  const n = labels.length;
  const tiers = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] === 1) tiers[i] = TIER.high;
    else if (labels[i] === 2) tiers[i] = TIER.medium;
  }
  const pxAreaHa = (grid.metersX * grid.metersY) / 10_000;
  const fc = buildPatchVectors(classGrid, labels, grid, pxAreaHa, {
    tiers,
    subs: null,
    persist: null,
    shortGap: false,
  });
  const confidences = fc.features.map((f) => (f.properties as Record<string, unknown>).confidence);
  assert.deepEqual(confidences.sort(), ["high", "medium"]);
});
