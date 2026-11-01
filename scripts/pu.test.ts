import assert from "node:assert/strict";
import test from "node:test";
import { prepareCompare, type RunCompareInput } from "../lib/analysis/process";
import {
  V1_INPUT_BANDS,
  V2_INPUT_BANDS,
  compositeSamples,
  estimateAnalysisPu,
  estimateRenderPu,
} from "../lib/analysis/pu";

/** Phase 5 — PU cost model (#15) and the native-resolution grid cap (#14). */

function makeInput(
  bbox: [number, number, number, number],
  over: Partial<RunCompareInput> = {},
): RunCompareInput {
  const [w, s, e, n] = bbox;
  return {
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [w, s],
          [e, s],
          [e, n],
          [w, n],
          [w, s],
        ],
      ],
    },
    dateA: "2026-05-01",
    dateB: "2026-05-20",
    areaName: "Test area",
    areaLevel: "tehsil",
    sensitivity: "medium",
    ...over,
  };
}

test("estimateRenderPu: official formula — size/bands/float/samples, 0.005 floor", () => {
  // Audit §5 worked numbers: 1500² grid → size factor 8.583.
  const v2Side = estimateRenderPu({
    width: 1500,
    height: 1500,
    inputBands: V2_INPUT_BANDS, // 9
    float: true,
    samples: 3,
  });
  assert.ok(Math.abs(v2Side - 154.5) < 0.5, `v2 side ≈154.5, got ${v2Side}`);

  const v1Side = estimateRenderPu({
    width: 1500,
    height: 1500,
    inputBands: V1_INPUT_BANDS, // 5
    float: true,
    samples: 1,
  });
  assert.ok(Math.abs(v1Side - 28.6) < 0.3, `v1 side ≈28.6, got ${v1Side}`);

  // Two renders per analysis.
  const analysis = estimateAnalysisPu({
    width: 1500,
    height: 1500,
    inputBands: V2_INPUT_BANDS,
    float: true,
    samples: 3,
  });
  assert.ok(Math.abs(analysis - 2 * v2Side) < 1e-9);

  // Degenerate sizes hit the official floors: the size factor min (0.01)
  // first, then the 0.005 PU per-request minimum when bands shave it below.
  const minSize = estimateRenderPu({ width: 1, height: 1, inputBands: 3, float: false, samples: 1 });
  assert.equal(minSize, 0.01, "size factor floor 0.01");
  const minRequest = estimateRenderPu({ width: 1, height: 1, inputBands: 1, float: false, samples: 1 });
  assert.equal(minRequest, 0.005, "per-request floor 0.005 PU");

  // Bands and samples scale linearly.
  const half = estimateRenderPu({ width: 100, height: 100, inputBands: 3, float: false, samples: 1 });
  const doubled = estimateRenderPu({ width: 100, height: 100, inputBands: 6, float: false, samples: 1 });
  assert.ok(Math.abs(doubled - 2 * half) < 1e-9);
});

test("compositeSamples: ±7 d → 3, window 0 → 1, ±15 d → 6 (5-day revisit)", () => {
  assert.equal(compositeSamples(7), 3);
  assert.equal(compositeSamples(0), 1);
  assert.equal(compositeSamples(15), 6);
});

test("prepareCompare: grid never upscales past native 10 m (#14)", () => {
  // ~0.004° ≈ 442 m → native long side ≈ 44 px, well under the 1500 cap.
  const prep = prepareCompare(makeInput([74.0, 26.0, 74.004, 26.004]));
  const longSide = Math.max(prep.width, prep.height);
  assert.ok(longSide < 100, `native-capped grid should be small, got ${longSide}px`);
  assert.ok(longSide >= 32, "GRID_MIN_PX floor respected");

  // Large AOI: the cap still binds (native would be ≫ 1500).
  const big = prepareCompare(makeInput([73.0, 25.0, 74.5, 26.5]));
  assert.equal(Math.max(big.width, big.height), 1500);

  // maxPx below native still wins (scenario parity: 400px on a ~442px-native box).
  const capped = prepareCompare(makeInput([74.0, 26.0, 74.04, 26.04], { maxPx: 400 }));
  assert.equal(Math.max(capped.width, capped.height), 400);
});

test("prepareCompare: estimates PU and enforces the cap before any fetch (#15)", () => {
  const bigBox: [number, number, number, number] = [73.0, 25.0, 74.5, 26.5];

  const prep = prepareCompare(makeInput(bigBox, { engine: "v2" }));
  assert.ok(prep.estimatedPu > 100, `full-size composite should be costly, got ${prep.estimatedPu}`);
  // 1500×~1350 grid × 9 bands × float × 3 samples × 2 renders ≈ 279 PU.
  assert.ok(
    prep.estimatedPu > 250 && prep.estimatedPu < 310,
    `≈279 PU for a full-size composite, got ${prep.estimatedPu}`,
  );

  // Over the limit → 413 PU_LIMIT_EXCEEDED (before any network work).
  assert.throws(
    () => prepareCompare(makeInput(bigBox, { engine: "v2" }), { puLimit: 50 }),
    (err: unknown) => {
      const e = err as { status?: number; code?: string };
      return e.status === 413 && e.code === "PU_LIMIT_EXCEEDED";
    },
  );

  // Limit 0 / omitted disables the guard; a generous limit passes.
  assert.ok(prepareCompare(makeInput(bigBox, { engine: "v2" }), { puLimit: 0 }).estimatedPu > 0);
  assert.ok(prepareCompare(makeInput(bigBox, { engine: "v2" }), { puLimit: 10_000 }).estimatedPu > 0);

  // Small AOI is far under any sane limit.
  const small = prepareCompare(
    makeInput([74.0, 26.0, 74.004, 26.004], { engine: "v2" }),
    { puLimit: 1 },
  );
  assert.ok(small.estimatedPu < 1, `tiny AOI PU should be < 1, got ${small.estimatedPu}`);
});
