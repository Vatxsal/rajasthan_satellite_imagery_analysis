import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeComparePair,
  swipeAttribution,
  swipeClipPath,
} from "../lib/compare/swipe";
import {
  addTileResponse,
  classifyTileResponse,
  emptyTileCount,
} from "../lib/compare/tileDebug";
import { buildTileUrl, buildTileUrlTemplate } from "../lib/map/tiles";
import type { Scene } from "../lib/data";

// ------------------------------------------------------------ normalizeComparePair

test("normalizeComparePair: ordered pair is untouched", () => {
  const pair = normalizeComparePair("2026-08-21", "2026-10-25");
  assert.deepEqual(pair, { dateA: "2026-08-21", dateB: "2026-10-25" });
});

test("normalizeComparePair: reversed picks are swapped (A = earlier)", () => {
  const pair = normalizeComparePair("2026-10-25", "2026-08-21");
  assert.deepEqual(pair, { dateA: "2026-08-21", dateB: "2026-10-25" });
});

test("normalizeComparePair: same date stays in place", () => {
  const pair = normalizeComparePair("2026-09-09", "2026-09-09");
  assert.deepEqual(pair, { dateA: "2026-09-09", dateB: "2026-09-09" });
});

test("normalizeComparePair: partial pairs pass through", () => {
  assert.deepEqual(normalizeComparePair("2026-10-25", null), {
    dateA: "2026-10-25",
    dateB: null,
  });
  assert.deepEqual(normalizeComparePair(null, "2026-10-25"), {
    dateA: null,
    dateB: "2026-10-25",
  });
  assert.deepEqual(normalizeComparePair(null, null), { dateA: null, dateB: null });
});

test("normalizeComparePair: ISO dates order chronologically across years", () => {
  const pair = normalizeComparePair("2026-01-02", "2025-12-31");
  assert.deepEqual(pair, { dateA: "2025-12-31", dateB: "2026-01-02" });
});

// ------------------------------------------------------------ swipeClipPath

test("swipeClipPath: 50% splits the viewport evenly", () => {
  assert.equal(swipeClipPath(50, "left"), "inset(0 50% 0 0)");
  assert.equal(swipeClipPath(50, "right"), "inset(0 0 0 50%)");
});

test("swipeClipPath: divider at the edges shows one full half", () => {
  assert.equal(swipeClipPath(0, "left"), "inset(0 100% 0 0)");
  assert.equal(swipeClipPath(0, "right"), "inset(0 0 0 0%)");
  assert.equal(swipeClipPath(100, "left"), "inset(0 0% 0 0)");
  assert.equal(swipeClipPath(100, "right"), "inset(0 0 0 100%)");
});

test("swipeClipPath: clamps out-of-range dividers", () => {
  assert.equal(swipeClipPath(150, "right"), "inset(0 0 0 100%)");
  assert.equal(swipeClipPath(-20, "left"), "inset(0 100% 0 0)");
});

test("swipeClipPath: fractional dividers are trimmed to 3 decimals", () => {
  assert.equal(swipeClipPath(33.3333333, "left"), "inset(0 66.667% 0 0)");
  assert.equal(swipeClipPath(33.3333333, "right"), "inset(0 0 0 33.333%)");
});

// ------------------------------------------------------------ swipeAttribution

test("swipeAttribution: dedupes a single year across both dates", () => {
  assert.equal(
    swipeAttribution({ dateA: "2026-08-21", dateB: "2026-10-25" }),
    "Contains modified Copernicus Sentinel data 2026 · © OpenStreetMap contributors",
  );
});

test("swipeAttribution: lists cross-year pairs sorted", () => {
  assert.equal(
    swipeAttribution({ dateA: "2025-11-02", dateB: "2026-01-10" }),
    "Contains modified Copernicus Sentinel data 2025, 2026 · © OpenStreetMap contributors",
  );
});

test("swipeAttribution: missing dates fall back to a dash", () => {
  assert.equal(
    swipeAttribution({ dateA: null, dateB: null }),
    "Contains modified Copernicus Sentinel data — · © OpenStreetMap contributors",
  );
});

// ------------------------------------------------------------ tile URLs

test("buildTileUrl: same-origin path with all four params", () => {
  const url = buildTileUrl({
    date: "2026-08-21",
    areaId: "alwar-rajgarh1",
    level: "tehsil",
    composite: "ndvi",
  });
  const [path, query] = url.split("?");
  assert.equal(path, "/api/tiles/{z}/{x}/{y}.png");
  const params = new URLSearchParams(query);
  assert.equal(params.get("date"), "2026-08-21");
  assert.equal(params.get("areaId"), "alwar-rajgarh1");
  assert.equal(params.get("level"), "tehsil");
  assert.equal(params.get("composite"), "ndvi");
});

test("buildTileUrlTemplate: delegates with the scene date", () => {
  const scene = { date: "2026-10-25" } as Scene;
  const template = buildTileUrlTemplate({
    scene,
    areaId: "alwar",
    level: "district",
    composite: "true-color",
  });
  const params = new URLSearchParams(template.split("?")[1]);
  assert.equal(params.get("date"), "2026-10-25");
  assert.equal(params.get("composite"), "true-color");
  assert.equal(params.get("level"), "district");
});

// ------------------------------------------------------------ tile debug tally

test("classifyTileResponse: ok / skip / rate-limit / failure buckets", () => {
  assert.equal(classifyTileResponse(200, null), "ok");
  assert.equal(classifyTileResponse(204, null), "ok");
  assert.equal(classifyTileResponse(200, "outside-area"), "skip");
  assert.equal(classifyTileResponse(200, "zoom"), "skip");
  assert.equal(classifyTileResponse(429, null), "limited");
  assert.equal(classifyTileResponse(500, null), "fail");
  assert.equal(classifyTileResponse(404, "outside-area"), "fail");
});

test("addTileResponse: accumulates per date and returns a new tally", () => {
  let tally = addTileResponse({}, "2026-08-21", 200, null);
  tally = addTileResponse(tally, "2026-08-21", 200, null);
  tally = addTileResponse(tally, "2026-08-21", 200, "outside-area");
  tally = addTileResponse(tally, "2026-08-21", 429, null);
  tally = addTileResponse(tally, "2026-10-25", 200, null);
  assert.deepEqual(tally["2026-08-21"], {
    ok: 2,
    skip: 1,
    limited: 1,
    fail: 0,
  });
  assert.deepEqual(tally["2026-10-25"], { ok: 1, skip: 0, limited: 0, fail: 0 });
});

test("addTileResponse: seeds an empty bucket for a new date", () => {
  const tally = addTileResponse({}, "2026-01-01", 500, null);
  assert.deepEqual(tally["2026-01-01"], { ...emptyTileCount(), fail: 1 });
});
