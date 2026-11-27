import "./alias-hook"; // must be first: installs the "@/…" resolver before the graph loads

import assert from "node:assert/strict";
import test from "node:test";
import {
  applyThresholdOverrides,
  clampThresholdValue,
  hasThresholdOverrides,
  presetThresholds,
  scaledThresholds,
  THRESHOLDS,
  THRESHOLD_BOUNDS,
  type ScaledThresholds,
  type ThresholdField,
} from "../lib/analysis/config";
import { compareCacheKey } from "../lib/cache";
import { clampCompareTuning, can, PERMISSIONS } from "../lib/auth/permissions";
import { compareParamsSchema, thresholdsSchema } from "../lib/server/compareRun";
import { queryCompareSchema } from "../lib/queries/repository";
import { buildStatsCsv, thresholdProvenance } from "../lib/compare/export";
import { buildSummaryPrompt } from "../lib/analysis/prompt";
import { buildReportEmailData } from "../lib/email/template/data";
import { processCompare, type CompareArtifact, type RasterInputs } from "../lib/analysis/process";
import { HISTOGRAM_BINS } from "../lib/analysis/diagnostics";
import { CLASS } from "../lib/analysis/config";

/**
 * Phase-thresholds regression suite — everything here runs offline: the
 * re-classification path is exercised through processCompare with synthetic
 * rasters (zero Process API calls by construction), and every Copernicus
 * touchpoint stays mocked-out (no network in these tests at all).
 */

/* ------------------------------------------------------------------ */
/* bounds + clamping                                                   */
/* ------------------------------------------------------------------ */

test("bounds: every field clamps to its honest range", () => {
  const cases: Array<[ThresholdField, number, number]> = [
    ["vegLossD", -99, -0.4],
    ["vegLossD", -0.001, -0.03],
    ["vegGainD", 99, 0.4],
    ["vegGainD", 0.001, 0.03],
    ["waterGainD", 99, 0.5],
    ["waterGainD", 0.001, 0.05],
    ["waterLossD", -99, -0.5],
    ["waterLossD", -0.001, -0.05],
    ["bareBuiltD", 99, 0.3],
    ["bareBuiltD", 0.001, 0.03],
    ["bareBuiltNdviMax", 99, 0],
    ["bareBuiltNdviMax", -99, -0.3],
    ["bareBuiltMaxMndwi", 99, 0.3],
    ["bareBuiltMaxMndwi", -99, -0.2],
    ["waterGainMndwiMin", 99, 0.3],
    ["waterGainMndwiMin", -99, -0.2],
    ["waterLossMndwiMin", 99, 0.3],
    ["waterLossMndwiMin", -99, -0.2],
  ];
  for (const [field, raw, expected] of cases) {
    assert.equal(clampThresholdValue(field, raw), expected, `${field} clamp ${raw}`);
  }
  // In-bounds values pass through untouched (2 dp).
  assert.equal(clampThresholdValue("vegLossD", -0.2), -0.2);
});

test("applyThresholdOverrides clamps out-of-bounds values, keeps the rest of the preset", () => {
  const base = scaledThresholds("high");
  const out = applyThresholdOverrides(base, {
    vegLossD: -99, // clamps to -0.40
    vegGainD: 0.2, // in-bounds, applied as-is
  });
  assert.equal(out.vegLossD, -0.4);
  assert.equal(out.vegGainD, 0.2);
  assert.equal(out.waterGainD, base.waterGainD, "unspecified fields keep the preset");
});

test("zod: the analyze schema clamps (never rejects) out-of-bounds overrides", () => {
  const parsed = compareParamsSchema.parse({
    areaId: "t-jalor-ahore",
    level: "tehsil",
    dateA: "2026-01-01",
    dateB: "2026-01-20",
    thresholds: { vegLossD: -99, waterGainD: 12, bareBuiltNdviMax: 0.5 },
  });
  assert.deepEqual(parsed.thresholds, {
    vegLossD: -0.4,
    waterGainD: 0.5,
    bareBuiltNdviMax: 0,
  });
  // Non-numeric values are rejected (validation, not clamping).
  assert.throws(() =>
    compareParamsSchema.parse({
      areaId: "t-jalor-ahore",
      level: "tehsil",
      dateA: "2026-01-01",
      dateB: "2026-01-20",
      thresholds: { vegLossD: "banana" },
    }),
  );
  // The standalone schema round-trips the same clamps.
  assert.deepEqual(thresholdsSchema.parse({ vegGainD: 99 }), { vegGainD: 0.4 });
});

/* ------------------------------------------------------------------ */
/* preset → slider mapping                                             */
/* ------------------------------------------------------------------ */

test("preset → slider mapping: base × factor, clamped into the editable bounds", () => {
  const medium = presetThresholds("medium");
  assert.equal(medium.vegLossD, -0.15);
  assert.equal(medium.vegGainD, 0.15);
  assert.equal(medium.waterGainD, 0.2);
  assert.equal(medium.waterLossD, -0.2);
  assert.equal(medium.bareBuiltD, 0.1);
  assert.equal(medium.bareBuiltNdviMax, -0.05);
  assert.equal(medium.bareBuiltMaxMndwi, 0.1);
  assert.equal(medium.waterGainMndwiMin, 0);
  assert.equal(medium.waterLossMndwiMin, 0);

  const high = presetThresholds("high");
  assert.ok(Math.abs(high.vegLossD - (-0.15 * 0.7)) < 1e-9, "high = base × 0.7");
  const low = presetThresholds("low");
  assert.ok(Math.abs(low.vegLossD - (-0.15 * 1.5)) < 1e-9, "low = base × 1.5");
  const veryhigh = presetThresholds("veryhigh");
  assert.ok(Math.abs(veryhigh.vegGainD - (0.15 * 0.5)) < 1e-9, "very high = base × 0.5");

  // Every preset stays inside the editable bounds (the sliders' own range).
  for (const preset of ["low", "medium", "high", "veryhigh", "auto"] as const) {
    const values = presetThresholds(preset);
    for (const field of Object.keys(THRESHOLD_BOUNDS) as ThresholdField[]) {
      const bounds = THRESHOLD_BOUNDS[field];
      assert.ok(
        values[field] >= bounds.min && values[field] <= bounds.max,
        `${preset}.${field}=${values[field]} inside [${bounds.min}, ${bounds.max}]`,
      );
    }
  }
  // The base defaults themselves agree with the documented README table.
  assert.equal(THRESHOLDS.vegLoss.dNdvi, -0.15);
  assert.equal(THRESHOLDS.waterGain.dMndwi, 0.2);
  assert.equal(THRESHOLDS.bareBuilt.dNdbi, 0.1);
});

/* ------------------------------------------------------------------ */
/* the Custom flag                                                      */
/* ------------------------------------------------------------------ */

test("Custom flag: any override is custom; empty/absent is preset", () => {
  assert.equal(hasThresholdOverrides(null), false);
  assert.equal(hasThresholdOverrides({}), false);
  assert.equal(hasThresholdOverrides({ vegLossD: -0.2 }), true);
  // NaN / non-numeric values do not count.
  assert.equal(hasThresholdOverrides({ vegLossD: Number.NaN }), false);
});

/* ------------------------------------------------------------------ */
/* cache keys: thresholds fork the classified key, never the raster key  */
/* ------------------------------------------------------------------ */

test("cache keys: thresholds fork the result key only", () => {
  const base = {
    areaId: "t-jalor-ahore",
    level: "tehsil",
    dateA: "2026-01-01",
    dateB: "2026-01-20",
    sensitivity: "high",
    minPatchHa: 0.05,
    engine: "v2",
    inputMode: "composite",
    compositeWindowDays: 7,
  };
  const plain = compareCacheKey(base);
  // Absent and empty thresholds keep the preset key (legacy-compatible).
  assert.equal(compareCacheKey({ ...base, thresholds: {} }), plain);
  // A real override forks the CLASSIFIED-result key…
  const custom = compareCacheKey({ ...base, thresholds: { vegLossD: -0.2 } });
  assert.notEqual(custom, plain);
  // …and different overrides fork differently.
  assert.notEqual(
    compareCacheKey({ ...base, thresholds: { vegLossD: -0.2 } }),
    compareCacheKey({ ...base, thresholds: { vegLossD: -0.25 } }),
  );
  // The raster key (same inputs WITHOUT thresholds) equals the preset key —
  // this is what ensureCompare uses for the derived-grid cache.
  assert.equal(compareCacheKey({ ...base }), plain);
});

/* ------------------------------------------------------------------ */
/* role gating                                                          */
/* ------------------------------------------------------------------ */

test("role gating: guests lose the overrides, SSO keeps them", () => {
  const params = {
    sensitivity: "high" as const,
    minPatchHa: 0.5,
    thresholds: { vegLossD: -0.2, vegGainD: 0.3 },
  };
  const guest = clampCompareTuning("guest", params);
  assert.equal(guest.thresholds, null, "guest overrides are stripped");
  assert.equal(can("guest", "compare.thresholds"), false);
  const sso = clampCompareTuning("sso", params);
  assert.deepEqual(sso.thresholds, params.thresholds, "sso overrides survive");
  assert.equal(can("sso", "compare.thresholds"), true);
  assert.equal(PERMISSIONS.guest.capabilities["compare.thresholds"], false);
  assert.equal(PERMISSIONS.sso.capabilities["compare.thresholds"], true);
});

/* ------------------------------------------------------------------ */
/* saved queries: validation + clamping                                */
/* ------------------------------------------------------------------ */

test("saved queries: thresholds are stored with validation and clamping", () => {
  const good = queryCompareSchema.parse({
    sensitivity: "high",
    minPatchHa: 0.05,
    thresholds: { vegLossD: -99, vegGainD: 0.2 },
  });
  assert.deepEqual(good.thresholds, { vegLossD: -0.4, vegGainD: 0.2 });
  // Strict schema: unknown rule names are rejected (typos, old exports).
  assert.throws(() =>
    queryCompareSchema.parse({ sensitivity: "high", minPatchHa: 0.05, thresholds: { notARule: 1 } }),
  );
  // Absent thresholds stay optional (legacy saved queries keep parsing).
  assert.equal(queryCompareSchema.parse({ sensitivity: "high", minPatchHa: 0.05 }).thresholds, undefined);
});

/* ------------------------------------------------------------------ */
/* zero-PU re-classification from the derived-grids cache              */
/* ------------------------------------------------------------------ */

/** Synthetic field: flat NDVI 0.4 → 0.28 (Δ −0.12), no water/bare. The grid
 *  dims come from the SAME prepare math the server uses, so the synthetic
 *  rasters always match the prepared analysis grid exactly. */
const BBOX: [number, number, number, number] = [74.0, 25.5, 74.01, 25.51];
const { computeOutputSize } = require("../lib/cdse/geometry") as {
  computeOutputSize: (bbox: [number, number, number, number], max: number) => { width: number; height: number };
};
const { nativeLongSidePx } = require("../lib/analysis/grid") as {
  nativeLongSidePx: (bbox: [number, number, number, number]) => number;
};
const GRID_W = computeOutputSize(BBOX, Math.max(32, Math.min(1500, Math.floor(nativeLongSidePx(BBOX))))).width;
const GRID_H = computeOutputSize(BBOX, Math.max(32, Math.min(1500, Math.floor(nativeLongSidePx(BBOX))))).height;
const N = GRID_W * GRID_H;

function synthSide(ndvi: number): RasterInputs["sideA"] {
  const indices = {
    ndvi: new Float32Array(N).fill(ndvi),
    mndwi: new Float32Array(N).fill(0),
    ndbi: new Float32Array(N).fill(0),
    width: GRID_W,
    height: GRID_H,
  };
  return { indices, valid: new Uint8Array(N).fill(1), width: GRID_W, height: GRID_H };
}

const rectGeometry: GeoJSON.Polygon = {
  type: "Polygon",
  coordinates: [
    [
      [BBOX[0], BBOX[1]],
      [BBOX[2], BBOX[1]],
      [BBOX[2], BBOX[3]],
      [BBOX[0], BBOX[3]],
      [BBOX[0], BBOX[1]],
    ],
  ],
};

const baseInput = {
  geometry: rectGeometry,
  dateA: "2026-01-01",
  dateB: "2026-02-01",
  areaName: "Thresholds fixture",
  areaLevel: "tehsil" as const,
  areaId: "thresholds-fixture",
  sensitivity: "medium" as const,
  minPatchHa: 0.01,
  speckle: "gentle" as const,
  engine: "v1" as const,
  zones: null,
};

function vegLossHa(artifact: CompareArtifact): number {
  const cls = artifact.result.classes.find((row) => row.code === CLASS.vegLoss);
  return cls?.areaHa ?? 0;
}

test("re-classification: cached derived grids, new thresholds, zero Process API calls", () => {
  const inputs: RasterInputs = { sideA: synthSide(0.4), sideB: synthSide(0.28) };

  // Run 1 — medium preset (ΔNDVI −0.12 never crosses −0.15): no veg loss,
  // and the derived grids are captured for the raster cache.
  const medium = processCompare({ ...baseInput, captureDerived: true }, { sideA: synthSide(0.4), sideB: synthSide(0.28) });
  assert.equal(vegLossHa(medium), 0, "medium preset: Δ −0.12 below −0.15");
  assert.ok(medium.derived, "derived grids captured for whole-AOI runs");
  assert.ok(medium.result.histograms, "compact histograms ride the result");
  assert.equal(medium.result.histograms!.ndvi.binCount, HISTOGRAM_BINS);
  assert.equal(HISTOGRAM_BINS, 200);
  assert.equal(medium.result.metadata.thresholdsCustom, undefined);

  // Run 2 — custom vegLoss −0.10: the same Δ now crosses → vegetation loss.
  const thresholds = { vegLossD: -0.1 };
  const customFresh = processCompare(
    { ...baseInput, thresholds, captureDerived: true },
    { sideA: synthSide(0.4), sideB: synthSide(0.28) },
  );
  assert.ok(vegLossHa(customFresh) > 0, "custom −0.10 flags the −0.12 delta");
  assert.equal(customFresh.result.metadata.thresholdsCustom, true);
  assert.equal(customFresh.result.metadata.thresholdsPreset, "medium");

  // Run 3 — THE ZERO-PU PATH: re-classify run 1's derived grids with the
  // custom thresholds and EMPTY raster inputs (no fetch, no derive). The
  // class grid must equal the fresh custom run exactly.
  const customCached = processCompare(
    { ...baseInput, thresholds },
    {},
    {},
    medium.derived,
  );
  assert.deepEqual([...customCached.classGrid], [...customFresh.classGrid], "cached == fresh classify");
  assert.ok(vegLossHa(customCached) > 0);
  assert.equal(customCached.result.metadata.thresholdsCustom, true);
  assert.deepEqual(
    customCached.result.metadata.thresholds,
    customFresh.result.metadata.thresholds,
    "identical effective thresholds",
  );
  // Histograms survive the cached path (the editor keeps its live feedback).
  assert.ok(customCached.result.histograms);
  assert.equal(customCached.result.histograms!.ndvi.binCount, HISTOGRAM_BINS);

  // Preset re-runs from the same cache work too (no thresholds → medium).
  const presetCached = processCompare({ ...baseInput }, {}, {}, medium.derived);
  assert.equal(vegLossHa(presetCached), 0);
  assert.deepEqual([...presetCached.classGrid], [...medium.classGrid]);
});

/* ------------------------------------------------------------------ */
/* transparency: exports, prompt, email                                 */
/* ------------------------------------------------------------------ */

test("transparency: CSV + provenance label custom runs with their values", () => {
  const medium = processCompare({ ...baseInput, captureDerived: false }, {
    sideA: synthSide(0.4),
    sideB: synthSide(0.28),
  });
  const custom = processCompare(
    { ...baseInput, thresholds: { vegLossD: -0.1 } },
    { sideA: synthSide(0.4), sideB: synthSide(0.28) },
  );

  const customProvenance = thresholdProvenance(custom.result.metadata);
  assert.equal(customProvenance.custom, true);
  assert.equal(customProvenance.preset, "medium");
  assert.match(customProvenance.values, /ΔNDVI loss ≤ −0\.10/);

  const customCsv = buildStatsCsv(custom.result);
  assert.match(customCsv, /Custom thresholds \(started from medium\)/);
  assert.match(customCsv, /Threshold vegLossD,-?0\.1/);
  assert.doesNotMatch(buildStatsCsv(medium.result), /Custom thresholds/);
  assert.match(buildStatsCsv(medium.result), /medium preset:/);
});

test("transparency: the AI summary prompt never calls a custom run default", () => {
  const custom = processCompare(
    { ...baseInput, thresholds: { vegLossD: -0.1 } },
    { sideA: synthSide(0.4), sideB: synthSide(0.28) },
  );
  const prompt = buildSummaryPrompt(custom.result);
  assert.match(prompt, /CUSTOM \(started from the medium preset/);
  assert.match(prompt, /hand-adjusted by the user/);
  assert.match(prompt, /not the default settings/);
  const medium = processCompare(
    { ...baseInput },
    { sideA: synthSide(0.4), sideB: synthSide(0.28) },
  );
  const presetPrompt = buildSummaryPrompt(medium.result);
  assert.doesNotMatch(presetPrompt, /CUSTOM/);
  assert.match(presetPrompt, /Sensitivity: medium/);
});

test("transparency: the emailed report carries the threshold provenance", () => {
  const custom = processCompare(
    { ...baseInput, thresholds: { vegLossD: -0.1 } },
    { sideA: synthSide(0.4),
      sideB: synthSide(0.28) },
  );
  const provenance = thresholdProvenance(custom.result.metadata);
  const thresholdLine = provenance.custom
    ? `Custom thresholds (started from ${provenance.preset}): ${provenance.values}`
    : `${provenance.preset} preset: ${provenance.values}`;
  const data = buildReportEmailData({
    language: "en",
    mode: "open",
    requestedAt: "2026-11-27T10:00:00.000Z",
    areaName: "Ahore",
    areaLevel: "tehsil",
    dateA: baseInput.dateA,
    dateB: baseInput.dateB,
    gapDays: 31,
    sensitivity: custom.result.metadata.sensitivity,
    thresholds: thresholdLine,
    minPatchHa: 0.01,
    inputMode: "single",
    stats: {
      classes: custom.result.classes,
      validPct: custom.result.validPct,
      validHa: custom.result.validHa,
      changedHa: custom.result.changedHa,
      tehsils: custom.result.tehsils,
      eventsTotal: custom.result.eventsTotal,
    },
    events: [],
    summary: null,
    includeSummary: false,
    summaryUnavailable: false,
    image: null,
    deepLink: "https://example.org/?a=t-jalor-ahore",
    siteUrl: "https://example.org",
    generatedAt: custom.result.metadata.generatedAt,
    rules: "legacy",
    evidence: null,
  });
  assert.match(data.thresholds, /Custom thresholds \(started from medium\)/);
  assert.match(data.thresholds, /ΔNDVI loss ≤ −0\.10/);
});

test("effective thresholds: a Custom run bypasses adaptive scaling (what you set is what applies)", () => {
  // The metadata echoes exactly the override, not a scaled variant.
  const custom = processCompare(
    { ...baseInput, thresholds: { vegLossD: -0.1, waterGainD: 0.3 } },
    { sideA: synthSide(0.4), sideB: synthSide(0.28) },
  );
  assert.equal(custom.result.metadata.thresholds.vegLossDNdvi, -0.1);
  assert.equal(custom.result.metadata.thresholds.waterGainDMndwi, 0.3);
  assert.deepEqual(custom.result.metadata.thresholdOverrides, {
    vegLossD: -0.1,
    waterGainD: 0.3,
  });
});
