import assert from "node:assert/strict";
import test from "node:test";
import type { CompositeBands } from "../lib/analysis/composite";
import { deriveV2Indices } from "../lib/analysis/v2";
import {
  SHARPEN_MIN_R2,
  sharpenSwir,
} from "../lib/analysis/sharpen";
import { compareCacheKey } from "../lib/cache";
import {
  prepareCompare,
  processCompare,
  type RunCompareInput,
} from "../lib/analysis/process";
import { buildScenarios } from "../validation/scenarios";

/**
 * SHARPEN_SWIR — regression-based B11/B12 sharpening: planted-relationship
 * recovery, guards (degenerate/poor fits, valid mask), mean preservation,
 * cache-key plumbing and the processCompare metadata flag.
 */

function emptyBands(n: number): CompositeBands {
  return {
    b02: new Float32Array(n),
    b03: new Float32Array(n),
    b04: new Float32Array(n),
    b05: new Float32Array(n),
    b08: new Float32Array(n),
    b11: new Float32Array(n),
    b12: new Float32Array(n),
  };
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Block-mean upsample of a sharp field — the "20 m observed" look. */
function blockBlur(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = x & ~1;
      const y0 = y & ~1;
      let sum = 0;
      let cnt = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const yy = y0 + dy;
          const xx = x0 + dx;
          if (yy >= h || xx >= w) continue;
          sum += src[yy * w + xx];
          cnt += 1;
        }
      }
      out[y * w + x] = sum / cnt;
    }
  }
  return out;
}

function rmse(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s / a.length);
}

function mean(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

test("sharpenSwir: planted linear relationship → sharp field recovered, mean preserved", () => {
  const w = 64;
  const h = 64;
  const n = w * h;
  const bands = emptyBands(n);
  const rnd = lcg(7);
  for (let i = 0; i < n; i++) {
    bands.b02[i] = 0.08 + rnd() * 0.3;
    bands.b03[i] = 0.1 + rnd() * 0.3;
    bands.b04[i] = 0.08 + rnd() * 0.3;
    bands.b05[i] = 0.15 + rnd() * 0.3;
    bands.b08[i] = 0.2 + rnd() * 0.45;
  }
  // Sharp truth: B11 = 0.3·B02 + 0.5·B08 + 0.05 (exactly linear in predictors).
  const truth = new Float32Array(n);
  for (let i = 0; i < n; i++) truth[i] = 0.3 * bands.b02[i] + 0.5 * bands.b08[i] + 0.05;
  // Observation = 20 m block blur of the truth (what the upsampled SWIR looks like).
  bands.b11 = blockBlur(truth, w, h);
  // B12 constant → degenerate target (ssTot = 0) → must stay untouched.
  bands.b12.fill(0.2);

  const observed = Float32Array.from(bands.b11);
  const observed12 = Float32Array.from(bands.b12);
  const res = sharpenSwir(bands, w, h, null);

  assert.equal(res.b11.applied, true, "B11 fit applied");
  assert.ok(res.b11.r2 >= SHARPEN_MIN_R2, `B11 r2 ${res.b11.r2} >= ${SHARPEN_MIN_R2}`);
  assert.equal(res.b12.applied, false, "constant B12 skipped");
  assert.deepEqual(Array.from(bands.b12), Array.from(observed12), "B12 untouched");

  // The sharpened field recovers the sharp truth far better than the blur did.
  assert.ok(rmse(bands.b11, truth) < 0.05 * rmse(observed, truth), "sharpened ≪ observed error");
  // Mean preserved (detail has zero mean per 2×2 block on even dims).
  assert.ok(Math.abs(mean(bands.b11) - mean(observed)) < 1e-4, "mean preserved");
  for (let i = 0; i < n; i++) assert.ok(Number.isFinite(bands.b11[i]), `finite at ${i}`);
});

test("sharpenSwir: degenerate predictors (constant) → no-op on both bands", () => {
  const w = 32;
  const h = 32;
  const n = w * h;
  const bands = emptyBands(n);
  for (const k of ["b02", "b03", "b04", "b05", "b08"] as const) bands[k].fill(0.25);
  bands.b11.fill(0.3);
  bands.b12.fill(0.18);
  const before11 = Float32Array.from(bands.b11);
  const before12 = Float32Array.from(bands.b12);

  const res = sharpenSwir(bands, w, h, null);
  assert.equal(res.b11.applied, false, "constant target skipped");
  assert.equal(res.b12.applied, false, "constant target skipped");
  assert.deepEqual(Array.from(bands.b11), Array.from(before11), "B11 untouched");
  assert.deepEqual(Array.from(bands.b12), Array.from(before12), "B12 untouched");
});

test("sharpenSwir: valid mask keeps garbage pixels out of the fit", () => {
  const w = 64;
  const h = 64;
  const n = w * h;
  const bands = emptyBands(n);
  const rnd = lcg(11);
  const valid = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      bands.b02[i] = 0.1 + rnd() * 0.3;
      bands.b03[i] = 0.1 + rnd() * 0.3;
      bands.b04[i] = 0.1 + rnd() * 0.3;
      bands.b05[i] = 0.1 + rnd() * 0.3;
      bands.b08[i] = 0.2 + rnd() * 0.4;
      if (x < w / 2) {
        // Clean left half: exact linear relationship.
        valid[i] = 1;
        bands.b11[i] = 0.4 * bands.b02[i] + 0.35 * bands.b08[i] + 0.02;
      } else {
        // Right half: wild garbage — would destroy an unmasked fit.
        valid[i] = 0;
        bands.b11[i] = 5;
      }
      bands.b12[i] = 0.2;
    }
  }
  const resMasked = sharpenSwir(bands, w, h, valid);
  assert.equal(resMasked.b11.applied, true, "masked fit uses the clean half only");
  const afterMasked = Float32Array.from(bands.b11);

  // Same data, no mask → garbage drags R² below the floor → skipped.
  const bands2 = emptyBands(n);
  for (const k of ["b02", "b03", "b04", "b05", "b08", "b11", "b12"] as const) {
    bands2[k].set(bands[k]);
  }
  const resUnmasked = sharpenSwir(bands2, w, h, null);
  assert.equal(resUnmasked.b11.applied, false, "unmasked garbage fit rejected");
  assert.deepEqual(Array.from(bands2.b11), Array.from(afterMasked), "rejected fit leaves data alone");
});

function puInput(over: Partial<RunCompareInput> = {}): RunCompareInput {
  return {
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [74.0, 26.0],
          [74.04, 26.0],
          [74.04, 26.04],
          [74.0, 26.04],
          [74.0, 26.0],
        ],
      ],
    },
    dateA: "2026-05-01",
    dateB: "2026-05-20",
    areaName: "Sharpen check",
    areaLevel: "tehsil",
    areaId: "sharpen-check",
    sensitivity: "medium",
    engine: "v2",
    inputMode: "composite",
    compositeWindowDays: 7,
    ...over,
  };
}

test("processCompare: sharpen flag records metadata + fit diagnostics", () => {
  const prep = prepareCompare(puInput());
  const { width, height } = prep;
  const n = width * height;
  const veg = [0.05, 0.06, 0.045, 0.3, 0.42, 0.22, 0.19];
  const keys = ["b02", "b03", "b04", "b05", "b08", "b11", "b12"] as const;

  function side() {
    const bands = Object.fromEntries(keys.map((k) => [k, new Float32Array(n)])) as Record<
      (typeof keys)[number],
      Float32Array
    >;
    const valid = new Uint8Array(n).fill(1);
    const obsCount = new Float32Array(n).fill(6);
    const scl = new Float32Array(n).fill(4);
    const rnd = lcg(3);
    for (let i = 0; i < n; i++) {
      keys.forEach((k, bi) => {
        bands[k][i] = veg[bi] + (rnd() - 0.5) * 0.01;
      });
    }
    const idx = deriveV2Indices(bands);
    return {
      width,
      height,
      ...bands,
      valid,
      obsCount,
      scl,
      recentNdvi: Float32Array.from(idx.ndvi),
      recentMndwi: Float32Array.from(idx.mndwi),
      recentNdbi: Float32Array.from(idx.ndbi),
    };
  }

  const off = processCompare(puInput(), { parsedA: side(), parsedB: side() });
  assert.equal(off.result.metadata.sharpen, undefined, "flag off → no metadata");

  const on = processCompare(puInput({ sharpen: true }), { parsedA: side(), parsedB: side() });
  assert.equal(on.result.metadata.sharpen, true, "flag on → metadata.sharpen");
  const stats = on.result.metadata.engineStats?.sharpen;
  assert.ok(stats, "engineStats.sharpen present");
  assert.equal(typeof stats.a.b11.r2, "number");
  assert.equal(typeof stats.b.b12.r2, "number");
});

test("compareCacheKey: SHARPEN_SWIR flips the key", () => {
  const base = {
    areaId: "d-jaipur",
    level: "district",
    dateA: "2026-05-01",
    dateB: "2026-05-20",
    sensitivity: "medium",
    minPatchHa: 3,
    engine: "v2",
    inputMode: "composite",
    compositeWindowDays: 7,
    rules: "fused",
    s1WindowDays: 6,
    worldCover: 1,
  };
  assert.equal(compareCacheKey(base), compareCacheKey({ ...base, sharpen: 0 }));
  assert.notEqual(compareCacheKey(base), compareCacheKey({ ...base, sharpen: 1 }));
});

test("scenarios: buildScenarios(..., sharpen=true) runs the full fused pipeline", () => {
  const cases = buildScenarios("v2", undefined, "fused", true);
  assert.equal(cases.length, 3);
  for (const c of cases) assert.ok(c.prediction.features.length >= 0);
});
