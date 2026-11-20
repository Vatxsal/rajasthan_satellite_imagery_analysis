import "./alias-hook"; // must be first: installs the "@/…" resolver before the module graph loads

import assert from "node:assert/strict";
import test from "node:test";
import { computeShapeStats, SHAPE_NODATA } from "../lib/draw/stats";

/** Pure-arithmetic coverage for computeShapeStats: NDVI over clear pixels
 *  only, SCL shares over all valid pixels, nodata excluded everywhere. */

test("stats: an all-nodata raster reports zero valid pixels and null stats", () => {
  const ndvi = [SHAPE_NODATA, SHAPE_NODATA, SHAPE_NODATA, SHAPE_NODATA];
  const scl = [0, 0, 0, 0];
  const stats = computeShapeStats(ndvi, scl);

  assert.deepEqual(stats.pixels, { total: 4, valid: 0, clear: 0, cloudy: 0, nodata: 4 });
  assert.equal(stats.ndvi, null);
  assert.equal(stats.scl, null);
});

test("stats: NDVI excludes cloudy pixels, SCL shares still count them", () => {
  // 3 clear (SCL 4/6), 1 cloud (SCL 9), 1 nodata outside the shape.
  const ndvi = [0.2, 0.4, 0.6, 0.99, SHAPE_NODATA];
  const scl = [4, 6, 4, 9, 0];
  const stats = computeShapeStats(ndvi, scl);

  assert.deepEqual(stats.pixels, { total: 5, valid: 4, clear: 3, cloudy: 1, nodata: 1 });

  // NDVI stats run over the 3 clear pixels only — 0.99 must not leak in.
  const ndviStats = stats.ndvi!;
  assert.equal(ndviStats.count, 3);
  assert.equal(ndviStats.mean, 0.4);
  assert.equal(ndviStats.min, 0.2);
  assert.equal(ndviStats.max, 0.6);

  // Shares are percentages of VALID pixels (4), one decimal.
  const shares = stats.scl!;
  assert.equal(shares.vegetation, 50); // 2 of 4
  assert.equal(shares.water, 25); // 1 of 4
  assert.equal(shares.cloud, 25); // 1 of 4
  assert.equal(shares.bare, 0);
  assert.equal(
    Math.round((shares.vegetation + shares.water + shares.cloud) * 10) / 10,
    100,
    "shares sum to 100%",
  );
});

test("stats: median and percentiles use linear interpolation (type 7)", () => {
  // Even count: median of [0.1, 0.2, 0.3, 0.4] = 0.25.
  const ndvi = [0.1, 0.2, 0.3, 0.4];
  const scl = [4, 4, 4, 4];
  const stats = computeShapeStats(ndvi, scl);

  assert.equal(stats.ndvi!.median, 0.25);
  assert.equal(stats.ndvi!.p25, 0.175); // 0.1 + (0.2-0.1) * 0.75
  assert.equal(stats.ndvi!.p75, 0.325); // 0.3 + (0.4-0.3) * 0.25
  assert.equal(stats.ndvi!.std, 0.1118, "population std, rounded to 4dp");
});

test("stats: shadow and unclassified SCL codes land in their groups", () => {
  const ndvi = [0.3, 0.3, 0.3, 0.3];
  const scl = [3, 7, 11, 4]; // shadow, built(7), other(11), vegetation
  const stats = computeShapeStats(ndvi, scl);

  const shares = stats.scl!;
  assert.equal(shares.shadow, 25);
  assert.equal(shares.built, 25);
  assert.equal(shares.other, 25);
  assert.equal(shares.vegetation, 25);
  assert.equal(shares.cloud, 0);
  // Shadow counts as cloudy for pixel bookkeeping but stays in NDVI (only
  // SCL 3/8/9/10 are excluded — 3 is in CLOUDY_SCL, so clear = 3 here).
  assert.equal(stats.pixels.cloudy, 1);
  assert.equal(stats.pixels.clear, 3);
});

test("stats: a single valid pixel yields exact stats", () => {
  const stats = computeShapeStats([0.42], [4]);
  assert.deepEqual(stats.pixels, { total: 1, valid: 1, clear: 1, cloudy: 0, nodata: 0 });
  assert.equal(stats.ndvi!.mean, 0.42);
  assert.equal(stats.ndvi!.median, 0.42);
  assert.equal(stats.ndvi!.min, 0.42);
  assert.equal(stats.ndvi!.max, 0.42);
  assert.equal(stats.scl!.vegetation, 100);
});
