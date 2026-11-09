import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CLASS, scaledThresholds, seasonalTag } from "../lib/analysis/config";
import {
  classifyModel,
  featureVectorAt,
  loadMlModel,
  makeFeatureExtractor,
  ML_FEATURES,
  mlModelPath,
  type MlModel,
} from "../lib/analysis/model";
import type { ClassifyFusedInput } from "../lib/analysis/fused";
import { PERSIST, TIER, deriveV2Indices, type V2Indices } from "../lib/analysis/v2";
import { prepareCompare, processCompare, type RunCompareInput } from "../lib/analysis/process";
import type { ParsedCompositeRaster } from "../lib/analysis/parse";
import { resolveChangeRules } from "../lib/env";
import { compareCacheKey } from "../lib/cache";
import { WC } from "../lib/analysis/prior";
import { featureRows } from "../validation/scenarios";
import type { RefClass } from "../validation/engine";

/**
 * Phase 4 — ML scaffold: feature extraction, softmax inference, model-file
 * loading (missing/bad), CHANGE_RULES=ml plumbing, scenario feature export.
 */

function zeroIndices(n: number): V2Indices {
  return {
    ndvi: new Float32Array(n),
    mndwi: new Float32Array(n),
    ndbi: new Float32Array(n),
    ndmi: new Float32Array(n),
    ndwi: new Float32Array(n),
    bsi: new Float32Array(n),
    awei: new Float32Array(n),
    brightness: new Float32Array(n),
    nbr: new Float32Array(n),
  };
}

function scenario(over: Partial<ClassifyFusedInput> = {}): ClassifyFusedInput {
  const n = 16;
  return {
    a: zeroIndices(n),
    b: zeroIndices(n),
    aRecent: {
      ndvi: new Float32Array(n),
      mndwi: new Float32Array(n),
      ndbi: new Float32Array(n),
    },
    bRecent: {
      ndvi: new Float32Array(n),
      mndwi: new Float32Array(n),
      ndbi: new Float32Array(n),
    },
    valid: new Uint8Array(n).fill(1),
    inside: new Uint8Array(n).fill(1),
    t: scaledThresholds("medium"),
    scales: { ndvi: 1, mndwi: 1, ndbi: 1, bsi: 1 },
    seasonalLossTag: null,
    seasonalGainTag: null,
    shortGap: false,
    ...over,
  };
}

/** Persistent bare/built pattern (dNdbi > 0 everywhere, recent agrees). */
function bareBuiltInput(): ClassifyFusedInput {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.ndvi.fill(0.5);
  b.ndvi.fill(0.42);
  a.ndbi.fill(-0.05);
  b.ndbi.fill(0.1);
  a.brightness.fill(0.15);
  b.brightness.fill(0.2);
  a.mndwi.fill(-0.05);
  b.mndwi.fill(-0.05);
  return scenario({
    a,
    b,
    aRecent: {
      ndvi: new Float32Array(n).fill(0.5),
      mndwi: Float32Array.from(a.mndwi),
      ndbi: Float32Array.from(a.ndbi),
    },
    bRecent: {
      ndvi: new Float32Array(n).fill(0.42),
      mndwi: Float32Array.from(b.mndwi),
      ndbi: Float32Array.from(a.ndbi, (v) => v + 0.14),
    },
  });
}

/** Tiny identity-standardised model: +dNdbi → bareBuilt, else noChange. */
function toyModel(over: Partial<MlModel> = {}): MlModel {
  return {
    version: 1,
    features: ["dNdbi"],
    classes: [CLASS.noChange, CLASS.bareBuilt],
    mean: [0],
    std: [1],
    weights: [[-3], [3]],
    bias: [0, 0],
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* feature extraction                                                  */
/* ------------------------------------------------------------------ */

test("feature extractor: deltas, CVA, evidence and flag columns", () => {
  const input = bareBuiltInput();
  const v = featureVectorAt(input, 0);
  assert.equal(v.length, ML_FEATURES.length);
  assert.ok(Math.abs(v[0] - (0.42 - 0.5)) < 1e-6, "dNdvi");
  assert.ok(Math.abs(v[2] - 0.15) < 1e-6, "dNdbi");
  assert.ok(v[12] > 1, `cva > 1 (${v[12]})`);
  assert.equal(v[13], 0, "no SAR → sarWaterTrans 0");
  assert.equal(v[14], 0, "no SAR → sarDvh 0");
  assert.equal(v[15], 0, "no prior → priorCode 0");
  assert.equal(v[16], 0, "no shadow");
  assert.equal(v[17], 0, "seasonalLoss off");
  assert.equal(v[19], 0, "shortGap off");

  const withEvidence = featureVectorAt(
    {
      ...input,
      seasonalLossTag: seasonalTag("2026-04-10", "loss"), // rabi-harvest window
      evidence: {
        sar: {
          dVV: new Float32Array(16),
          dVH: new Float32Array(16).fill(1.2),
          dRatio: new Float32Array(16),
          waterMaskA: new Uint8Array(16),
          waterMaskB: new Uint8Array(16).fill(1),
          thresholdA: -20,
          thresholdB: -20,
          valid: new Uint8Array(16).fill(1),
        },
        prior: {
          cls: new Uint8Array(16).fill(WC.builtup),
          valid: new Uint8Array(16).fill(1),
          tiles: ["N24E072"],
          year: 2021,
        },
        shadow: new Uint8Array(16).fill(1),
      },
    },
    0,
  );
  assert.equal(withEvidence[13], 1, "mask transition 0→1");
  assert.ok(Math.abs(withEvidence[14] - 1.2) < 1e-6, "dVH");
  assert.equal(withEvidence[15], WC.builtup, "priorCode");
  assert.equal(withEvidence[16], 1, "shadow on");
  assert.equal(withEvidence[17], 1, "seasonalLoss on");
});

test("feature extractor: masked/outside pixels yield the zero vector", () => {
  const input = bareBuiltInput();
  const masked = { ...input, valid: new Uint8Array(16) };
  const outside = { ...input, inside: new Uint8Array(16) };
  for (const v of [featureVectorAt(masked, 0), featureVectorAt(outside, 0)]) {
    assert.ok(v.every((x) => x === 0), "zero vector");
  }
});

/* ------------------------------------------------------------------ */
/* inference                                                           */
/* ------------------------------------------------------------------ */

test("classifyModel: argmax class, probability confidence, tier mapping", () => {
  const input = bareBuiltInput();
  const out = classifyModel(input, toyModel());
  for (let i = 0; i < 16; i++) {
    assert.equal(out.classGrid[i], CLASS.bareBuilt, `pixel ${i}`);
    const conf = out.confGrid[i];
    assert.ok(conf >= 50 && conf <= 100, `conf ${conf}`);
    // sigmoid(3·0.15) ≈ 0.67 → conf ≈ 67 → medium tier (55..74).
    assert.equal(out.tierGrid[i], TIER.medium);
    assert.equal(out.subGrid[i], 0, "scaffold emits no sub-labels");
    assert.equal(out.persistGrid[i], PERSIST.yes, "recent orbit agrees");
  }
  assert.equal(out.changePixels, 16);
  assert.equal(out.persistentPixels, 16);
  assert.ok(out.cvaMean > 1);

  // Negative dNdbi (weight −3 vs +3) → argmax noChange.
  const inverse = bareBuiltInput();
  [inverse.a.ndbi, inverse.b.ndbi] = [inverse.b.ndbi, inverse.a.ndbi];
  const out2 = classifyModel(inverse, toyModel());
  assert.equal(out2.changePixels, 0);
  assert.equal(out2.classGrid[0], CLASS.noChange);
  assert.equal(out2.confGrid[0], 0);
});

test("classifyModel: masked and outside pixels carry no class/confidence", () => {
  const base = bareBuiltInput();
  const masked = { ...base, valid: new Uint8Array(16) };
  const outM = classifyModel(masked, toyModel());
  assert.equal(outM.classGrid[0], CLASS.masked);
  assert.equal(outM.confGrid[0], 0);

  const outside = { ...base, inside: new Uint8Array(16) };
  const outO = classifyModel(outside, toyModel());
  assert.equal(outO.classGrid[0], CLASS.outside);
  assert.equal(outO.confGrid[0], 0);
});

test("classifyModel: unknown feature name → CDSE_ML_MODEL_BAD", () => {
  assert.throws(
    () => classifyModel(bareBuiltInput(), toyModel({ features: ["bogus"] })),
    (e: unknown) => (e as { code?: string }).code === "CDSE_ML_MODEL_BAD",
  );
});

/* ------------------------------------------------------------------ */
/* model loading                                                       */
/* ------------------------------------------------------------------ */

test("loadMlModel: missing file → CDSE_ML_MODEL_MISSING", () => {
  assert.throws(
    () => loadMlModel(path.join(tmpdir(), "definitely-not-a-model.json")),
    (e: unknown) => (e as { code?: string }).code === "CDSE_ML_MODEL_MISSING",
  );
});

test("loadMlModel: malformed content → CDSE_ML_MODEL_BAD", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rse-ml-"));
  try {
    const bad = path.join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ version: 2 }));
    assert.throws(
      () => loadMlModel(bad),
      (e: unknown) => (e as { code?: string }).code === "CDSE_ML_MODEL_BAD",
    );
    writeFileSync(bad, "not json at all");
    assert.throws(
      () => loadMlModel(bad),
      (e: unknown) => (e as { code?: string }).code === "CDSE_ML_MODEL_BAD",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadMlModel: valid file round-trips; ML_MODEL_PATH overrides default", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rse-ml-"));
  const previous = process.env.ML_MODEL_PATH;
  try {
    const file = path.join(dir, "model.json");
    writeFileSync(file, JSON.stringify(toyModel()));
    const loaded = loadMlModel(file);
    assert.deepEqual(loaded.classes, toyModel().classes);
    assert.deepEqual(loaded.features, ["dNdbi"]);

    process.env.ML_MODEL_PATH = file;
    assert.equal(mlModelPath(), file);
    assert.deepEqual(loadMlModel().bias, [0, 0]);
  } finally {
    if (previous === undefined) delete process.env.ML_MODEL_PATH;
    else process.env.ML_MODEL_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* rules plumbing                                                      */
/* ------------------------------------------------------------------ */

test("resolveChangeRules: ml forces the v2 engine like fused", () => {
  assert.deepEqual(resolveChangeRules({ CHANGE_RULES: "ml", CHANGE_ENGINE: "v1" }), {
    rules: "ml",
    engine: "v2",
  });
  assert.deepEqual(resolveChangeRules({ CHANGE_RULES: "ml", CHANGE_ENGINE: "v2" }), {
    rules: "ml",
    engine: "v2",
  });
});

test("compareCacheKey: ml keys differ from fused and legacy", () => {
  const base = {
    areaId: "a",
    level: "tehsil" as const,
    dateA: "2026-05-01",
    dateB: "2026-05-20",
    sensitivity: "medium",
    minPatchHa: 0.2,
    engine: "v2",
    inputMode: "composite",
    compositeWindowDays: 7,
  };
  const legacy = compareCacheKey({ ...base, rules: "legacy" });
  const fused = compareCacheKey({ ...base, rules: "fused" });
  const ml = compareCacheKey({ ...base, rules: "ml" });
  assert.notEqual(ml, legacy);
  assert.notEqual(ml, fused);
  assert.notEqual(fused, legacy);
});

/* ------------------------------------------------------------------ */
/* processCompare integration                                          */
/* ------------------------------------------------------------------ */

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
    areaName: "ML check",
    areaLevel: "tehsil",
    areaId: "ml-check",
    sensitivity: "medium",
    engine: "v2",
    inputMode: "composite",
    compositeWindowDays: 7,
    ...over,
  };
}

test("processCompare: rules=ml runs the model and records metadata", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rse-ml-"));
  const previous = process.env.ML_MODEL_PATH;
  try {
    // Mean/std identity, +dNdbi → bareBuilt (matches the synthetic block).
    writeFileSync(
      path.join(dir, "model.json"),
      JSON.stringify(toyModel({ mean: [0], std: [1] })),
    );
    process.env.ML_MODEL_PATH = path.join(dir, "model.json");

    const input = puInput({
      rules: "ml",
      evidencePlan: { s1WindowDays: 6, terrain: true },
      maxPx: 64,
    });
    const prep = prepareCompare(input);
    const { width, height } = prep;
    const n = width * height;
    const evidence = {
      s1: { skipped: "no-common-orbit" } as { skipped: string },
      prior: {
        cls: new Uint8Array(n).fill(WC.cropland),
        valid: new Uint8Array(n).fill(1),
        tiles: ["N24E072"],
        year: 2021,
      },
      terrain: {
        slopeDeg: new Float32Array(n),
        hillshade: new Float32Array(n).fill(Math.SQRT1_2),
        shadow: new Uint8Array(n),
      },
      demInstance: "COPERNICUS_30",
    };

    const artifact = processCompare(
      input,
      synthSides(width, height),
      evidence,
    );
    const meta = artifact.result.metadata;
    assert.equal(meta.rules, "ml");
    assert.equal(meta.engine, "v2");
    assert.ok(meta.evidence, "evidence meta present for ml runs");
    assert.equal(meta.evidence.worldCover, true);

    let detected = 0;
    for (let i = 0; i < artifact.classGrid.length; i++) {
      if (artifact.classGrid[i] === CLASS.bareBuilt) detected += 1;
    }
    assert.ok(detected > 0, `model detected the block (${detected} px)`);
    const events = artifact.patchVectors.features;
    assert.ok(events.length > 0, "events vectorized");
    const props = events[0].properties as Record<string, unknown>;
    assert.equal(props.classCode, CLASS.bareBuilt);
    const conf = props.confidencePct as number;
    assert.ok(conf >= 0 && conf <= 100, `confidencePct ${conf}`);
    // Block ΔNDBI ≈ 0.36 → sigmoid(3·0.36) ≈ 0.75 → conf 74; the compact
    // 8×8 block then gains +10 from applyShapeEvidence → 84 → high.
    assert.equal(props.confidence, "high");
  } finally {
    if (previous === undefined) delete process.env.ML_MODEL_PATH;
    else process.env.ML_MODEL_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("processCompare: rules=ml without a model fails loudly", () => {
  const previous = process.env.ML_MODEL_PATH;
  try {
    process.env.ML_MODEL_PATH = path.join(tmpdir(), "rse-no-model-here.json");
    const input = puInput({ rules: "ml", maxPx: 64 });
    const prep = prepareCompare(input);
    assert.throws(
      () => processCompare(input, synthSides(prep.width, prep.height)),
      (e: unknown) => (e as { code?: string }).code === "CDSE_ML_MODEL_MISSING",
    );
  } finally {
    if (previous === undefined) delete process.env.ML_MODEL_PATH;
    else process.env.ML_MODEL_PATH = previous;
  }
});

/** Synthetic A/B composites: veg background + a centre bare→built block. */
function synthSides(
  width: number,
  height: number,
): { parsedA: ParsedCompositeRaster; parsedB: ParsedCompositeRaster } {
  const n = width * height;
  const veg = [0.05, 0.06, 0.045, 0.3, 0.42, 0.22, 0.19];
  const bare = [0.15, 0.17, 0.14, 0.26, 0.2, 0.24, 0.22];
  const built = [0.34, 0.16, 0.1305, 0.28, 0.16, 0.42, 0.4];
  const keys = ["b02", "b03", "b04", "b05", "b08", "b11", "b12"] as const;

  function side(states: "a" | "b") {
    const bands = Object.fromEntries(
      keys.map((k) => [k, new Float32Array(n)]),
    ) as Record<(typeof keys)[number], Float32Array>;
    const valid = new Uint8Array(n).fill(1);
    const obsCount = new Float32Array(n).fill(6);
    const scl = new Float32Array(n).fill(4);
    const c0 = Math.floor(width / 2) - 4;
    const r0 = Math.floor(height / 2) - 4;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const i = r * width + c;
        const inBlock = r >= r0 && r < r0 + 8 && c >= c0 && c < c0 + 8;
        const profile = inBlock ? (states === "a" ? bare : built) : veg;
        keys.forEach((k, bi) => {
          bands[k][i] = profile[bi];
        });
      }
    }
    const idx = deriveV2Indices(bands);
    return {
      width,
      height,
      ...bands,
      valid,
      obsCount,
      scl,
      recentNdvi: Float32Array.from(idx.ndvi, (v) => v + 0.001),
      recentMndwi: Float32Array.from(idx.mndwi),
      recentNdbi: Float32Array.from(idx.ndbi),
    };
  }

  return { parsedA: side("a"), parsedB: side("b") };
}

/* ------------------------------------------------------------------ */
/* feature export (npm run features)                                   */
/* ------------------------------------------------------------------ */

test("featureRows: scenario-classes yields every class with full vectors", () => {
  const perLabel = new Map<RefClass, number>();
  let rows = 0;
  let bad = 0;
  for (const row of featureRows("scenario-classes")) {
    rows += 1;
    perLabel.set(row.label, (perLabel.get(row.label) ?? 0) + 1);
    if (row.features.length !== ML_FEATURES.length) bad += 1;
    for (const v of row.features) {
      if (!Number.isFinite(v)) bad += 1;
    }
  }
  assert.equal(bad, 0, "all feature values finite and correctly sized");
  assert.ok(rows > 100_000, `full grid exported (${rows} rows)`);
  for (const cls of [
    "no_change",
    "veg_loss",
    "water_gain",
    "builtup_increase",
    "water_loss",
    "veg_gain",
  ] as RefClass[]) {
    assert.ok((perLabel.get(cls) ?? 0) > 0, `label ${cls} present`);
  }
});

test("featureRows: cloud scenario skips invalid pixels", () => {
  let rows = 0;
  for (const _ of featureRows("scenario-clouds")) rows += 1;
  // Grid ≈ 360×400; the cloud blob (+ dilation) removes a few thousand.
  assert.ok(rows > 100_000, `still most of the grid (${rows})`);
  assert.ok(rows < 144_000, `cloud pixels skipped (${rows})`);
});

test("makeFeatureExtractor reuses the caller buffer", () => {
  const extract = makeFeatureExtractor(bareBuiltInput());
  const buf = new Float32Array(ML_FEATURES.length);
  const out = extract(0, buf);
  assert.equal(out, buf, "same buffer returned");
});
