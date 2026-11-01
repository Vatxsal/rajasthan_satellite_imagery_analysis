import assert from "node:assert/strict";
import test from "node:test";
import { compositeTimeRange, deriveIndices } from "../lib/analysis/composite";
import { COMPARE_EVALSCRIPT, COMPARE_EVALSCRIPT_COMPOSITE } from "../lib/analysis/evalscript";
import { dilateInvalid } from "../lib/analysis/classify";
import { compareCacheKey } from "../lib/cache";

const DAY_MS = 86_400_000;

function dateAfter(baseIso: string, days: number): string {
  return new Date(Date.parse(`${baseIso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

test("compositeTimeRange: window 0 = the single UTC day", () => {
  const tr = compositeTimeRange("2026-06-15", 0);
  assert.equal(tr.from, "2026-06-15T00:00:00Z");
  assert.equal(tr.to, "2026-06-15T23:59:59Z");
});

test("compositeTimeRange: ±windowDays around the date", () => {
  const tr = compositeTimeRange("2026-06-15", 7);
  assert.equal(tr.from, "2026-06-08T00:00:00Z");
  assert.equal(tr.to, "2026-06-15T23:59:59Z");
});

test("compositeTimeRange: window capped at the midpoint between the dates", () => {
  const nearA = compositeTimeRange("2026-06-15", 7, "2026-06-16");
  assert.equal(nearA.to, "2026-06-15T12:00:00Z");
  const nearB = compositeTimeRange("2026-06-16", 7, "2026-06-15");
  assert.equal(nearB.from, "2026-06-15T12:00:00Z");

  const farA = compositeTimeRange("2026-06-15", 7, "2026-08-14");
  assert.equal(farA.to, "2026-06-15T23:59:59Z");
  assert.equal(farA.from, "2026-06-08T00:00:00Z");
});

test("compositeTimeRange: A/B windows ordered, never overlapping", () => {
  for (const gap of [1, 2, 3, 10, 60]) {
    const dateA = "2026-06-15";
    const dateB = dateAfter(dateA, gap);
    const a = compositeTimeRange(dateA, 7, dateB);
    const b = compositeTimeRange(dateB, 7, dateA);
    assert.ok(a.from < a.to, `A ordered (gap ${gap})`);
    assert.ok(b.from < b.to, `B ordered (gap ${gap})`);
    assert.ok(a.to <= b.from, `no A/B window overlap (gap ${gap}): ${a.to} vs ${b.from}`);
  }
});

test("deriveIndices: exact v1 evalscript formulas", () => {
  const n = 3;
  const bands = {
    b02: new Float32Array(n),
    b03: new Float32Array([0.3, 0, 0.2]),
    b04: new Float32Array([0.2, 0, 0.4]),
    b05: new Float32Array(n),
    b08: new Float32Array([0.6, 0, 0.4]),
    b11: new Float32Array([0.1, 0, 0]),
    b12: new Float32Array(n),
  };
  const { ndvi, mndwi, ndbi } = deriveIndices(bands);

  // pixel 0: NDVI = (0.6-0.2)/0.8 = 0.5 · MNDWI = (0.3-0.1)/0.4 = 0.5
  assert.ok(Math.abs(ndvi[0] - 0.5) < 1e-5);
  assert.ok(Math.abs(mndwi[0] - 0.5) < 1e-5);
  assert.ok(Math.abs(ndbi[0] - (0.1 - 0.6) / 0.7) < 1e-5);

  // pixel 1: all-zero bands → zero denominators → index 0 (v1 convention)
  assert.equal(ndvi[1], 0);
  assert.equal(mndwi[1], 0);
  assert.equal(ndbi[1], 0);

  // pixel 2: MNDWI with SWIR 0 → 1; NDBI with SWIR 0 → -1
  assert.ok(Math.abs(ndvi[2] - 0) < 1e-6);
  assert.equal(mndwi[2], 1);
  assert.equal(ndbi[2], -1);
});

test("composite evalscript: ORBIT median, cloud-gated, 12 FLOAT32 bands", () => {
  const es = COMPARE_EVALSCRIPT_COMPOSITE;
  assert.ok(es.startsWith("//VERSION=3"));
  assert.ok(es.includes('mosaicking: "ORBIT"'), "must use ORBIT (samples = orbits, not tiles)");
  assert.ok(!es.includes("MULTI_TEMPORAL"), "MULTI_TEMPORAL is not a valid v3 mosaicking mode");
  assert.ok(es.includes("bands: 12"));
  assert.ok(es.includes('sampleType: "FLOAT32"'));
  assert.ok(es.includes('mosaickingOrder: "mostRecent"'), "recent-orbit bands need newest-first samples");
  assert.ok(es.includes("CLD"), "cloud-probability gate");
  assert.ok(es.includes('"B05"') && es.includes('"B12"'), "full band set for Phase 2");
  assert.ok(es.includes("function median"), "per-pixel median of valid orbits");
  assert.ok(es.includes(JSON.stringify([0, 1, 3, 8, 9, 10, 11])), "same SCL exclusions as v1");
  assert.ok(
    es.includes("ndviOf(recent)") && es.includes("mndwiOf(recent)") && es.includes("ndbiOf(recent)"),
    "recent-orbit indices for the persistence check (Phase 2.7)",
  );
});

test("v1 evalscript: single-day ORBIT, server-side indices, rounded SCL gate", () => {
  const es = COMPARE_EVALSCRIPT;
  assert.ok(es.startsWith("//VERSION=3"));
  assert.ok(es.includes('mosaicking: "ORBIT"'));
  assert.ok(es.includes("bands: 5"));
  assert.ok(es.includes('"B03", "B04", "B08", "B11"'));
  assert.ok(!es.includes("CLD"));
  assert.ok(es.includes("Math.round(scl)"), "fractional SCL from bilinear resample must be rounded (#18)");
});

test("dilateInvalid: 1 px halo by default, 2 px for the v2 composite", () => {
  const W = 11;
  const H = 11;
  const valid = new Uint8Array(W * H).fill(1);
  valid[5 * W + 5] = 0;

  const r1 = dilateInvalid(valid, W, H);
  assert.equal(r1[5 * W + 6], 0, "1 px away killed at radius 1");
  assert.equal(r1[5 * W + 7], 1, "2 px away survives at radius 1");
  assert.deepEqual(Array.from(dilateInvalid(valid, W, H, 1)), Array.from(r1), "explicit 1 = default");

  const r2 = dilateInvalid(valid, W, H, 2);
  assert.equal(r2[5 * W + 6], 0);
  assert.equal(r2[5 * W + 7], 0, "2 px away killed at radius 2");
  assert.equal(r2[5 * W + 8], 1, "3 px away survives at radius 2");
  assert.equal(r2[(5 - 2) * W + (5 - 2)], 0, "diagonal within box radius 2 killed");
});

test("compareCacheKey: engine and input settings split the cache", () => {
  const base = {
    areaId: "d1",
    level: "district",
    dateA: "2026-01-01",
    dateB: "2026-02-01",
    sensitivity: "medium",
    minPatchHa: 0.2,
    engine: "v1",
    inputMode: "single",
    compositeWindowDays: 0,
  };
  const k = compareCacheKey(base);
  assert.equal(compareCacheKey(base), k, "stable for identical input");
  assert.notEqual(compareCacheKey({ ...base, engine: "v2" }), k, "engine changes key");
  assert.notEqual(
    compareCacheKey({ ...base, engine: "v2", inputMode: "composite" }),
    k,
    "input mode changes key",
  );
  assert.notEqual(
    compareCacheKey({ ...base, engine: "v2", inputMode: "composite", compositeWindowDays: 7 }),
    k,
    "window changes key",
  );
});
