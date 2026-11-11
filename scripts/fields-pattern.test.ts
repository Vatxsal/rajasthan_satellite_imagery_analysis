import "./alias-hook"; // must be first: installs the "@/…" resolver before the pattern graph loads

import assert from "node:assert/strict";
import test from "node:test";
import {
  agriYearMonths,
  classifySeries,
  estimatePatternPu,
  gapFill,
  groupSeries,
  preparePatternGrid,
  rasterizeFieldZones,
  seriesMetrics,
  smooth3,
  zonalMonthlyMeans,
  type PatternMonth,
} from "../lib/fields/pattern";
import {
  runPattern,
  type PatternMonthRaster,
  type PatternParams,
} from "../lib/fields/patternRun";
import { PATTERN_CLASSES } from "../lib/fields/config";
import { makeAnalysisGrid } from "../lib/analysis/grid";
import type { AnalysisGrid } from "../lib/analysis/types";
import type { BBox } from "../lib/data/types";
import type { FieldFeature, FieldsFiltered } from "../lib/fields/query";

/** Phase-2 pattern logic: agri-year calendar, curve shaping, the classification
 *  rules, grid zonal stats, the PU estimate, deterministic grouping, and an
 *  end-to-end runPattern pass over synthetic monthly rasters (no network, no
 *  GeoTIFF decode — the harness stubs geotiff). */

// ── helpers ─────────────────────────────────────────────────────────────────

function classify(series: number[]): ReturnType<typeof classifySeries> {
  return classifySeries(smooth3(series), seriesMetrics(series));
}

function field(id: string, west: number, south: number, east: number, north: number): FieldFeature {
  return {
    type: "Feature",
    id,
    geometry: {
      type: "Polygon",
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    },
    properties: { areaM2: 160_000, confidence: 90 },
  };
}

function makeFiltered(features: FieldFeature[]): FieldsFiltered {
  return {
    count: features.length,
    truncated: false,
    excluded: { confidence: 0, noConfidence: 0 },
    totalAreaM2: features.reduce((sum, feature) => sum + feature.properties.areaM2, 0),
    fields: { type: "FeatureCollection", features },
  };
}

const BBOX: BBox = [0, 0, 3, 3];
const GRID: AnalysisGrid = makeAnalysisGrid(BBOX, 30, 30); // 0.1° pixels

function paramsFor(grouping: boolean): PatternParams {
  return {
    bbox: BBOX,
    year: 2024,
    minConfidence: 69,
    grouping,
    grid: GRID,
    estimatedPu: estimatePatternPu(GRID),
  };
}

/** Three curve families, one per 10-column band of the 30-column grid. */
const KHARIF = [0.6, 0.7, 0.65, 0.4, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
const RABI = [0.1, 0.1, 0.1, 0.1, 0.5, 0.6, 0.65, 0.6, 0.4, 0.2, 0.1, 0.1];
const FLAT = new Array<number>(12).fill(0.1);
const CURVES = [KHARIF, RABI, FLAT];

const BAND_LONS: Array<[number, number]> = [
  [0.1, 0.5],
  [1.1, 1.5],
  [2.1, 2.5],
];
const FIELD_LATS: Array<[number, number]> = [
  [0.1, 0.5],
  [0.6, 1.0],
  [1.1, 1.5],
  [1.6, 2.0],
  [2.1, 2.5],
];

/** 15 fields: 5 per band, so every field sits entirely inside one band. */
function bandFields(): FieldFeature[] {
  const features: FieldFeature[] = [];
  BAND_LONS.forEach(([west, east], band) => {
    FIELD_LATS.forEach(([south, north], row) => {
      features.push(field(`f-${band}-${row}`, west, south, east, north));
    });
  });
  return features;
}

function syntheticMonth(grid: AnalysisGrid, monthIndex: number, curves: number[][]): PatternMonthRaster {
  const ndvi = new Float32Array(grid.width * grid.height);
  const valid = new Uint8Array(grid.width * grid.height);
  for (let row = 0; row < grid.height; row++) {
    for (let col = 0; col < grid.width; col++) {
      const band = Math.min(curves.length - 1, Math.floor((col / grid.width) * curves.length));
      ndvi[row * grid.width + col] = curves[band][monthIndex];
      valid[row * grid.width + col] = 1;
    }
  }
  return { width: grid.width, height: grid.height, ndvi, valid };
}

function uniformRaster(grid: AnalysisGrid, value: number, valid: number): PatternMonthRaster {
  const pixels = grid.width * grid.height;
  return {
    width: grid.width,
    height: grid.height,
    ndvi: new Float32Array(pixels).fill(value),
    valid: new Uint8Array(pixels).fill(valid),
  };
}

interface Frame {
  type: string;
  stage?: string;
  index?: number;
  label?: string;
  [key: string]: unknown;
}

function collect(): { frames: Frame[]; onEvent: (frame: unknown) => void } {
  const frames: Frame[] = [];
  return { frames, onEvent: (frame) => frames.push(frame as Frame) };
}

// ── agri-year calendar ──────────────────────────────────────────────────────

test("agriYearMonths: June of `year` through May of `year + 1`", () => {
  const months = agriYearMonths(2024);
  assert.equal(months.length, 12);
  assert.deepEqual(
    months.map((month) => month.label),
    [
      "2024-06",
      "2024-07",
      "2024-08",
      "2024-09",
      "2024-10",
      "2024-11",
      "2024-12",
      "2025-01",
      "2025-02",
      "2025-03",
      "2025-04",
      "2025-05",
    ],
  );
  assert.deepEqual(
    months.map((month) => month.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(months[0].from, "2024-06-01T00:00:00Z");
  assert.equal(months[0].to, "2024-06-30T23:59:59Z");
  assert.equal(months[6].to, "2024-12-31T23:59:59Z");
  assert.equal(months[11].to, "2025-05-31T23:59:59Z");
});

test("agriYearMonths: February length follows the calendar year it falls in", () => {
  // index 8 = February of year + 1 (agri year 2023 contains leap Feb 2024).
  assert.equal(agriYearMonths(2023)[8].to, "2024-02-29T23:59:59Z");
  assert.equal(agriYearMonths(2024)[8].to, "2025-02-28T23:59:59Z");
  assert.equal(agriYearMonths(2025)[8].to, "2026-02-28T23:59:59Z");
  assert.equal(agriYearMonths(2024)[8].label, "2025-02");
});

// ── series shaping ──────────────────────────────────────────────────────────

test("gapFill: an all-missing series stays null", () => {
  assert.equal(gapFill(new Array<number | null>(12).fill(null)), null);
});

test("gapFill: interior gaps interpolate, trailing months repeat the last value", () => {
  assert.deepEqual(gapFill([0, null, null, 30, null, 50, null, null]), [
    0, 10, 20, 30, 40, 50, 50, 50,
  ]);
});

test("gapFill: leading months repeat the first observation", () => {
  assert.deepEqual(gapFill([null, null, 6, 9]), [6, 6, 6, 9]);
});

test("gapFill: a complete series passes through unchanged", () => {
  const series = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  assert.deepEqual(gapFill(series), series);
});

test("smooth3: centred mean with two-point edges", () => {
  assert.deepEqual(smooth3([1, 2, 3, 4]), [1.5, 2, 3, 3.5]);
  assert.deepEqual(smooth3([5, 5, 5, 5]), [5, 5, 5, 5]);
  assert.deepEqual(smooth3([7]), [7]);
  assert.deepEqual(smooth3([]), []);
});

// ── metrics ─────────────────────────────────────────────────────────────────

test("seriesMetrics: mean/min/max/greenMonths and the three season means", () => {
  const series = [0.6, 0.7, 0.65, 0.4, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
  const metrics = seriesMetrics(series);
  assert.ok(Math.abs(metrics.mean - 3.15 / 12) < 1e-12);
  assert.equal(metrics.min, 0.1);
  assert.equal(metrics.max, 0.7);
  assert.equal(metrics.peakMonth, 1);
  assert.equal(metrics.greenMonths, 4);
  assert.ok(Math.abs(metrics.kharifMean - 2.35 / 4) < 1e-12);
  assert.ok(Math.abs(metrics.rabiMean - 0.6 / 6) < 1e-12);
  assert.equal(metrics.zaidMean, 0.1);
});

test("seriesMetrics: peakMonth is the FIRST index attaining the max", () => {
  const metrics = seriesMetrics([0.5, 0.5, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4]);
  assert.equal(metrics.peakMonth, 0);
  assert.equal(metrics.greenMonths, 12);
});

// ── classification rules ────────────────────────────────────────────────────

test("classify: peak below GREEN_MIN is fallow", () => {
  assert.equal(classify(new Array<number>(12).fill(0.1)), "fallow");
  assert.equal(classify([0.24, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.24]), "fallow");
});

test("classify: green every month is evergreen", () => {
  assert.equal(classify(new Array<number>(12).fill(0.5)), "evergreen");
  assert.equal(classify(new Array<number>(12).fill(0.4)), "evergreen");
});

test("classify: two deep peaks are double-cropped", () => {
  const curve = [0.1, 0.3, 0.6, 0.3, 0.1, 0.05, 0.1, 0.3, 0.55, 0.3, 0.1, 0.05];
  assert.equal(classify(curve), "double-cropped");
});

test("classify: a shallow dip between peaks is NOT double-cropped", () => {
  // Valley sits only 0.10 below the weaker peak (< DIP 0.15) → kharif-only.
  const curve = [0.1, 0.6, 0.35, 0.55, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1];
  assert.equal(classify(curve), "kharif-only");
});

test("classify: a peak in Apr/May is zaid", () => {
  const curve = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.5, 0.3];
  assert.equal(classify(curve), "zaid");
  assert.equal(seriesMetrics(curve).peakMonth, 10);
});

test("classify: monsoon peak with kharif dominance is kharif-only", () => {
  assert.equal(classify(KHARIF), "kharif-only");
});

test("classify: winter peak with rabi dominance is rabi-only", () => {
  assert.equal(classify(RABI), "rabi-only");
});

test("classify: the rules can produce every declared class except the upstream fallback", () => {
  const produced = new Set([
    classify(new Array<number>(12).fill(0.1)),
    classify(new Array<number>(12).fill(0.5)),
    classify([0.1, 0.3, 0.6, 0.3, 0.1, 0.05, 0.1, 0.3, 0.55, 0.3, 0.1, 0.05]),
    classify([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.2, 0.5, 0.3]),
    classify(KHARIF),
    classify(RABI),
  ]);
  assert.deepEqual(
    [...produced].sort(),
    PATTERN_CLASSES.filter((name) => name !== "unclassified").sort(),
  );
});

// ── zonal statistics ────────────────────────────────────────────────────────

function grid3x3(): AnalysisGrid {
  return makeAnalysisGrid([0, 0, 3, 3], 3, 3);
}

test("rasterizeFieldZones: a full-bbox square tags every pixel with zone 1", () => {
  const zones = rasterizeFieldZones([field("a", 0, 0, 3, 3)], grid3x3());
  assert.deepEqual(Array.from(zones), [1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

test("rasterizeFieldZones: tags are feature index + 1 and first-wins on overlap", () => {
  const left = field("a", 0, 0, 1, 3); // column 0 only
  const all = field("b", 0, 0, 3, 3); // overlaps everything
  const zones = rasterizeFieldZones([left, all], grid3x3());
  assert.deepEqual(Array.from(zones), [1, 2, 2, 1, 2, 2, 1, 2, 2]);
});

test("rasterizeFieldZones: a disjoint feature contributes nothing", () => {
  const zones = rasterizeFieldZones([field("far", 10, 10, 11, 11)], grid3x3());
  assert.deepEqual(Array.from(zones), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("zonalMonthlyMeans: valid pixels only; empty zones are null", () => {
  const zones = Int32Array.from([1, 1, 2, 0]);
  const raster = {
    width: 4,
    height: 1,
    // 0.25/0.75/0.5 are exact in binary → the mean is exactly 0.5.
    ndvi: Float32Array.from([0.25, 0.75, 0.5, 0.5]),
    valid: Uint8Array.from([1, 1, 0, 1]),
  };
  assert.deepEqual(zonalMonthlyMeans(zones, raster, 2), [0.5, null]);
});

test("zonalMonthlyMeans: a zone with only invalid pixels is null", () => {
  const zones = Int32Array.from([1, 1]);
  const raster = {
    width: 2,
    height: 1,
    ndvi: Float32Array.from([0.5, 0.5]),
    valid: Uint8Array.from([0, 0]),
  };
  assert.deepEqual(zonalMonthlyMeans(zones, raster, 1), [null]);
});

// ── grid & cost ─────────────────────────────────────────────────────────────

test("preparePatternGrid: native resolution, capped long side, GRID_MIN_PX floor", () => {
  const wide = preparePatternGrid([75, 26.9, 75.5, 26.91]); // ~0.5° long side
  assert.ok(wide.width <= 1024, `long side ${wide.width} must respect PATTERN_MAX_PX`);
  assert.ok(wide.width > wide.height);

  const tiny = preparePatternGrid([75, 26.9, 75.0001, 26.9001]); // ~11 m
  assert.ok(Math.max(tiny.width, tiny.height) >= 32, "GRID_MIN_PX floor");
});

test("estimatePatternPu: a ≤25 km² selection stays far under the default 700 PU limit", () => {
  // 5 km × 5 km at 27°N ≈ 25 km² (native grid ≈ 500 px long side).
  const grid = preparePatternGrid([75.5, 26.9, 75.5504, 26.9352]);
  const pu = estimatePatternPu(grid);
  assert.ok(pu > 100, `expected a real run, got ${pu} PU`);
  assert.ok(pu < 250, `expected ≈183 PU for 25 km², got ${pu}`);
});

// ── deterministic grouping ──────────────────────────────────────────────────

function blob(curve: number[], count: number): number[][] {
  return Array.from({ length: count }, () => [...curve]);
}

test("groupSeries: three separated curves → k=3, deterministic labels", () => {
  const series = [...blob(KHARIF, 10), ...blob(RABI, 10), ...blob(FLAT, 10)];
  const first = groupSeries(series);
  const second = groupSeries(series.map((entry) => [...entry]));
  assert.ok(first, "grouping expected");
  assert.equal(first.k, 3);
  assert.deepEqual(second, first, "same input → same grouping");

  assert.equal(first.labels.length, 30);
  assert.deepEqual([...new Set(first.labels)].sort(), [0, 1, 2]);
  const band0 = new Set(first.labels.slice(0, 10));
  const band1 = new Set(first.labels.slice(10, 20));
  const band2 = new Set(first.labels.slice(20, 30));
  assert.equal(band0.size, 1, "each blob collapses to one group");
  assert.equal(band1.size, 1);
  assert.equal(band2.size, 1);
  assert.notEqual(first.labels[0], first.labels[10]);
  assert.notEqual(first.labels[0], first.labels[20]);
  assert.notEqual(first.labels[10], first.labels[20]);
});

test("groupSeries: below the minimum field count there is no grouping", () => {
  const series = Array.from({ length: 11 }, (_, i) => new Array<number>(12).fill(i / 11));
  assert.equal(groupSeries(series), null);
});

test("groupSeries: identical curves produce no grouping", () => {
  const series = Array.from({ length: 15 }, () => [...FLAT]);
  assert.equal(groupSeries(series), null);
});

// ── runPattern (end-to-end over synthetic monthly rasters) ──────────────────

interface RecordedRun {
  fetches: number[];
  result: Awaited<ReturnType<typeof runPattern>>;
  frames: Frame[];
}

async function runSynthetic(
  options: {
    grouping?: boolean;
    raster?: (monthIndex: number) => PatternMonthRaster;
  } = {},
): Promise<RecordedRun> {
  const { grouping = false } = options;
  const { frames, onEvent } = collect();
  const fetches: number[] = [];
  const rasterFor =
    options.raster ??
    ((monthIndex: number): PatternMonthRaster => syntheticMonth(GRID, monthIndex, CURVES));

  const result = await runPattern(
    { ...paramsFor(grouping) },
    {
      fields: makeFiltered(bandFields()),
      fetchMonth: async (month: PatternMonth) => {
        fetches.push(month.index);
        return rasterFor(month.index);
      },
      onEvent,
    },
  );
  return { fetches, result, frames };
}

test("runPattern: 12 month frames then stage analyze, one fetch per month", async () => {
  const { fetches, frames, result } = await runSynthetic();
  assert.deepEqual(fetches, Array.from({ length: 12 }, (_unused, index) => index));
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["stage", ...Array.from({ length: 12 }, () => "month"), "stage"],
  );
  assert.equal(frames[0].stage, "ndvi");
  assert.deepEqual(
    frames.slice(1, 13).map((frame) => frame.index),
    Array.from({ length: 12 }, (_unused, index) => index),
  );
  assert.equal(frames[13].stage, "analyze");
  assert.equal(result.count, 15);
  assert.equal(result.months.length, 12);
  assert.equal(result.grouping.enabled, false);
  assert.equal(result.fields.length, 15);
});

test("runPattern: three bands → five fields per class, the rest zero", async () => {
  const { result } = await runSynthetic();
  assert.deepEqual(result.classes, {
    "double-cropped": 0,
    evergreen: 0,
    fallow: 5,
    "kharif-only": 5,
    "rabi-only": 5,
    unclassified: 0,
    zaid: 0,
  });
  assert.equal(result.fields.length, 15);
  const byId = new Map(result.fields.map((entry) => [entry.id, entry]));
  assert.equal(byId.get("f-0-0")?.cls, "kharif-only");
  assert.equal(byId.get("f-1-0")?.cls, "rabi-only");
  assert.equal(byId.get("f-2-0")?.cls, "fallow");
  const kharif = byId.get("f-0-0");
  assert.ok(kharif?.series, "kharif field carries a series");
  assert.ok(Math.abs((kharif?.series?.[1] ?? 0) - 0.7) < 1e-6, "peak lands in July");
  assert.equal(kharif?.validMonths, 12);
  assert.ok(kharif?.metrics);
  assert.equal(byId.get("f-1-0")?.metrics?.peakMonth, 6);
  // Flat band: peak 0.1 < GREEN_MIN → fallow, but all 12 months were observed.
  assert.ok(byId.get("f-2-0")?.series, "fallow keeps the observed curve");
  assert.ok(byId.get("f-2-0")?.metrics);
  assert.equal(byId.get("f-2-0")?.validMonths, 12);
});

test("runPattern: grouping=true adds a k and per-group sizes to the result", async () => {
  const { result } = await runSynthetic({ grouping: true });
  assert.equal(result.grouping.enabled, true);
  assert.equal(result.grouping.k, 3);
  assert.deepEqual([...result.grouping.sizes].sort((a, b) => a - b), [5, 5, 5]);
  assert.equal(result.fields.length, 15);
  const groupsByBand = [
    result.fields.filter((entry) => entry.id.startsWith("f-0-")),
    result.fields.filter((entry) => entry.id.startsWith("f-1-")),
    result.fields.filter((entry) => entry.id.startsWith("f-2-")),
  ];
  for (const band of groupsByBand) {
    const labels = new Set(band.map((entry) => entry.group));
    assert.equal(labels.size, 1, "each band collapses into one group");
    assert.notEqual([...labels][0], undefined);
  }
  const distinct = groupsByBand.map((band) => band[0]?.group);
  assert.equal(new Set(distinct).size, 3, "the three bands land in three groups");
});

test("runPattern: fewer than three valid months is unclassified with null stats", async () => {
  const raster = (monthIndex: number): PatternMonthRaster => {
    if (monthIndex > 1) return uniformRaster(GRID, 0, 0);
    return syntheticMonth(GRID, monthIndex, CURVES);
  };
  const { result } = await runSynthetic({ raster });
  assert.equal(result.classes.unclassified, 15);
  for (const entry of result.fields) {
    assert.equal(entry.cls, "unclassified");
    assert.equal(entry.validMonths, 2);
    assert.equal(entry.series, null);
    assert.equal(entry.metrics, null);
  }
});

test("runPattern: a dim mismatch fails with 502 UPSTREAM_ERROR", async () => {
  const raster = (): PatternMonthRaster => ({
    width: GRID.width - 1,
    height: GRID.height,
    ndvi: new Float32Array((GRID.width - 1) * GRID.height),
    valid: new Uint8Array((GRID.width - 1) * GRID.height),
  });
  await assert.rejects(
    runSynthetic({ raster }),
    (error: unknown) => {
      const pattern = error as { status?: number; code?: string };
      assert.equal(pattern.status, 502);
      assert.equal(pattern.code, "UPSTREAM_ERROR");
      return true;
    },
  );
});

test("runPattern: a mid-batch failure rejects after reporting earlier months", async () => {
  const { frames, onEvent } = collect();
  const fetches: number[] = [];
  const failAt = 5;
  await assert.rejects(
    runPattern(
      { ...paramsFor(false) },
      {
        fields: makeFiltered(bandFields()),
        fetchMonth: async (month: PatternMonth) => {
          fetches.push(month.index);
          if (month.index === failAt) throw new Error("upstream 503");
          return syntheticMonth(GRID, month.index, CURVES);
        },
        onEvent,
      },
    ),
    /upstream 503/,
  );
  // Batch order: months 0–3, then 4–7 (rejects inside the second batch).
  assert.deepEqual(fetches, [0, 1, 2, 3, 4, 5, 6, 7]);
  const monthFrames = frames.filter((frame) => frame.type === "month");
  assert.deepEqual(
    monthFrames.map((frame) => frame.index),
    [0, 1, 2, 3, 4, 6, 7],
    "fulfilled siblings in the failing batch still report",
  );
});
