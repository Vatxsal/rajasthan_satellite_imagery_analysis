import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASS,
  SUB,
  scaledThresholds,
  seasonalTag,
} from "../lib/analysis/config";
import {
  applyShapeEvidence,
  classifyFused,
  confFromScore,
  tierFromConf,
  type ClassifyFusedInput,
} from "../lib/analysis/fused";
import {
  classifyV2,
  deriveV2Indices,
  TIER,
} from "../lib/analysis/v2";
import type { V2Indices } from "../lib/analysis/v2";
import type { SarFeatures } from "../lib/analysis/s1";
import type { WorldCoverPrior } from "../lib/analysis/prior";
import { WC } from "../lib/analysis/prior";
import {
  prepareCompare,
  processCompare,
  type RunCompareInput,
} from "../lib/analysis/process";
import { resolveChangeRules } from "../lib/env";
import { compareCacheKey } from "../lib/cache";

/**
 * Phase 3 — fused rules: no-evidence equivalence with legacy v2, the three
 * evidence streams (SAR / WorldCover prior / terrain shadow), confidence
 * 0-100 mapping, patch-shape evidence, PU budgeting and env/key plumbing.
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
    vBare: new Float32Array(n),
    vBright: new Float32Array(n),
  };
}

function scenario(over: Partial<ClassifyFusedInput> = {}): ClassifyFusedInput {
  const n = 16;
  const t = scaledThresholds("medium");
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
    t,
    scales: { ndvi: 1, mndwi: 1, ndbi: 1, bsi: 1 },
    seasonalLossTag: null,
    seasonalGainTag: null,
    shortGap: false,
    ...over,
  };
}

/** Persistent veg-loss pattern (3 votes, CVA, recent agrees). */
function vegLossInput(): ClassifyFusedInput {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.ndvi.fill(0.6);
  b.ndvi.fill(0.3);
  a.ndmi.fill(0.4);
  b.ndmi.fill(0.15);
  a.bsi.fill(-0.2);
  b.bsi.fill(0.0);
  a.mndwi.fill(-0.1);
  b.mndwi.fill(-0.1);
  return scenario({
    a,
    b,
    aRecent: {
      ndvi: new Float32Array(n).fill(0.6),
      mndwi: new Float32Array(n).fill(-0.1),
      ndbi: new Float32Array(n),
    },
    bRecent: {
      ndvi: new Float32Array(n).fill(0.28),
      mndwi: new Float32Array(n).fill(-0.1),
      ndbi: new Float32Array(n),
    },
  });
}

/** Transient water gain (2-of-3 optical, no recent agreement). */
function waterGainInput(): ClassifyFusedInput {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.mndwi.fill(-0.1);
  b.mndwi.fill(0.2);
  a.ndwi.fill(-0.05);
  b.ndwi.fill(0.25);
  b.awei.fill(0.15);
  return scenario({
    a,
    b,
    aRecent: {
      ndvi: new Float32Array(n),
      mndwi: Float32Array.from(a.mndwi),
      ndbi: new Float32Array(n),
    },
    bRecent: {
      ndvi: new Float32Array(n),
      mndwi: Float32Array.from(a.mndwi, (v) => v + 0.01),
      ndbi: new Float32Array(n),
    },
  });
}

/** Persistent water loss. */
function waterLossInput(): ClassifyFusedInput {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.mndwi.fill(0.25);
  b.mndwi.fill(-0.15);
  a.ndwi.fill(0.2);
  b.ndwi.fill(-0.1);
  a.awei.fill(0.15);
  b.awei.fill(-0.1);
  return scenario({
    a,
    b,
    aRecent: {
      ndvi: new Float32Array(n),
      mndwi: Float32Array.from(a.mndwi),
      ndbi: new Float32Array(n),
    },
    bRecent: {
      ndvi: new Float32Array(n),
      mndwi: Float32Array.from(b.mndwi),
      ndbi: new Float32Array(n),
    },
  });
}

/** Bare/built full votes with mild veg dip (sub-threshold). */
function bareBuiltInput(): ClassifyFusedInput {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.ndvi.fill(0.5);
  b.ndvi.fill(0.42);
  a.ndmi.fill(0.3);
  b.ndmi.fill(0.3);
  a.bsi.fill(-0.1);
  b.bsi.fill(0.1);
  a.ndbi.fill(-0.05);
  b.ndbi.fill(0.1);
  a.brightness.fill(0.15);
  b.brightness.fill(0.2);
  a.vBare.fill(-0.05);
  b.vBare.fill(0.4); // 10 m anchor: bare → built blue/green contrast
  a.vBright.fill(0.15);
  b.vBright.fill(0.2); // 10 m support: visible brightening
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

function sarFixture(n: number, over: Partial<SarFeatures> = {}): SarFeatures {
  return {
    dVV: new Float32Array(n),
    dVH: new Float32Array(n),
    dRatio: new Float32Array(n),
    waterMaskA: new Uint8Array(n),
    waterMaskB: new Uint8Array(n),
    thresholdA: -20,
    thresholdB: -20,
    valid: new Uint8Array(n).fill(1),
    ...over,
  };
}

function priorFixture(n: number, cls: number): WorldCoverPrior {
  return {
    cls: new Uint8Array(n).fill(cls),
    valid: new Uint8Array(n).fill(1),
    tiles: ["N24E072"],
    year: 2021,
  };
}

/* ------------------------------------------------------------------ */
/* confidence mapping + no-evidence equivalence                         */
/* ------------------------------------------------------------------ */

test("confFromScore/tierFromConf: monotonic and reproduces v2 tier cut-points", () => {
  assert.equal(confFromScore(4), 80);
  assert.equal(confFromScore(2), 60);
  assert.equal(confFromScore(1), 50);
  assert.equal(confFromScore(0), 40);
  assert.equal(confFromScore(-5), 0); // clamped
  assert.equal(confFromScore(20), 100); // clamped
  assert.equal(tierFromConf(80), TIER.high);
  assert.equal(tierFromConf(75), TIER.high);
  assert.equal(tierFromConf(74), TIER.medium);
  assert.equal(tierFromConf(60), TIER.medium);
  assert.equal(tierFromConf(55), TIER.medium);
  assert.equal(tierFromConf(54), TIER.low);
  assert.equal(tierFromConf(0), TIER.low);
});

test("classifyFused ≡ classifyV2 with no evidence (class/tier/persist)", () => {
  const cases: Array<[string, ClassifyFusedInput]> = [
    ["vegLoss", vegLossInput()],
    ["waterGain", waterGainInput()],
    ["waterLoss", waterLossInput()],
    ["bareBuilt", bareBuiltInput()],
    ["empty", scenario()],
  ];
  for (const [name, input] of cases) {
    const legacy = classifyV2(input);
    const fused = classifyFused(input);
    assert.deepEqual(
      Array.from(fused.classGrid),
      Array.from(legacy.classGrid),
      `${name}: classGrid`,
    );
    assert.deepEqual(
      Array.from(fused.tierGrid),
      Array.from(legacy.tierGrid),
      `${name}: tierGrid`,
    );
    assert.deepEqual(
      Array.from(fused.persistGrid),
      Array.from(legacy.persistGrid),
      `${name}: persistGrid`,
    );
    assert.equal(fused.changePixels, legacy.changePixels, `${name}: changePixels`);
    assert.ok(Math.abs(fused.cvaMean - legacy.cvaMean) < 1e-6, `${name}: cvaMean`);
    // conf ↔ tier internal consistency.
    for (let i = 0; i < fused.confGrid.length; i++) {
      if (fused.classGrid[i] === CLASS.noChange) {
        assert.equal(fused.confGrid[i], 0, `${name}: conf of non-change`);
        continue;
      }
      assert.equal(tierFromConf(fused.confGrid[i]), fused.tierGrid[i], `${name}: conf↔tier`);
    }
    // Veg/water subs stay on the legacy vocabulary (non-seasonal inputs).
    if (name === "vegLoss" || name === "waterGain" || name === "waterLoss") {
      assert.deepEqual(Array.from(fused.subGrid), Array.from(legacy.subGrid), `${name}: subs`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* WorldCover prior                                                    */
/* ------------------------------------------------------------------ */

test("prior cropland → bare_agri sub-label with a confidence penalty", () => {
  const input = bareBuiltInput();
  const base = classifyFused(input);
  assert.equal(base.subGrid[0], SUB.bareBuiltPossible, "4 votes + persistent + bright → possible");
  const withCrop = classifyFused({
    ...input,
    evidence: { prior: priorFixture(16, WC.cropland) },
  });
  assert.equal(withCrop.classGrid[0], CLASS.bareBuilt, "cropland keeps the event");
  assert.equal(withCrop.subGrid[0], SUB.bareBuiltAgriculture);
  assert.ok(
    withCrop.confGrid[0] < base.confGrid[0],
    `crop penalty lowers conf (${withCrop.confGrid[0]} < ${base.confGrid[0]})`,
  );
  assert.ok(withCrop.tierGrid[0] <= base.tierGrid[0]);
});

test("prior built-up before date A → not NEW built-up (suppressed)", () => {
  const input = bareBuiltInput();
  const base = classifyFused(input);
  assert.equal(base.classGrid[0], CLASS.bareBuilt);
  const withPrior = classifyFused({
    ...input,
    evidence: { prior: priorFixture(16, WC.builtup) },
  });
  assert.equal(withPrior.classGrid[0], CLASS.noChange);
  assert.equal(withPrior.changePixels, 0);
  assert.equal(withPrior.subGrid[0], 0);
});

test("prior water: suppresses water_gain, keeps water_loss", () => {
  const gain = waterGainInput();
  const baseGain = classifyFused(gain);
  assert.equal(baseGain.classGrid[0], CLASS.waterGain);
  const gainOnPriorWater = classifyFused({
    ...gain,
    evidence: { prior: priorFixture(16, WC.water) },
  });
  assert.equal(gainOnPriorWater.classGrid[0], CLASS.noChange, "already water → no gain event");

  const loss = waterLossInput();
  const lossOnPriorWater = classifyFused({
    ...loss,
    evidence: { prior: priorFixture(16, WC.water) },
  });
  assert.equal(lossOnPriorWater.classGrid[0], CLASS.waterLoss, "drying of known water stays");
});

/* ------------------------------------------------------------------ */
/* terrain shadow                                                      */
/* ------------------------------------------------------------------ */

test("terrain shadow deletes candidate water (gain and loss), not bare/built", () => {
  const gain = waterGainInput();
  assert.equal(classifyFused(gain).classGrid[0], CLASS.waterGain);
  const shadow = new Uint8Array(16).fill(1);
  assert.equal(
    classifyFused({ ...gain, evidence: { shadow } }).classGrid[0],
    CLASS.noChange,
    "shadowed gain suppressed",
  );

  const loss = waterLossInput();
  assert.equal(
    classifyFused({ ...loss, evidence: { shadow } }).classGrid[0],
    CLASS.noChange,
    "shadowed loss suppressed",
  );

  const bare = bareBuiltInput();
  assert.equal(
    classifyFused({ ...bare, evidence: { shadow } }).classGrid[0],
    CLASS.bareBuilt,
    "shadow does not touch bare/built",
  );
});

/* ------------------------------------------------------------------ */
/* Sentinel-1 SAR                                                      */
/* ------------------------------------------------------------------ */

test("SAR water-mask transition corroborates; dry-SAR weakens", () => {
  const input = waterGainInput();
  const base = classifyFused(input);
  const agree = classifyFused({
    ...input,
    evidence: { sar: sarFixture(16, { waterMaskB: new Uint8Array(16).fill(1) }) },
  });
  assert.ok(
    agree.confGrid[0] > base.confGrid[0],
    `SAR agrees (${agree.confGrid[0]} > ${base.confGrid[0]})`,
  );
  const dry = classifyFused({ ...input, evidence: { sar: sarFixture(16) } }); // masks 0/0
  assert.ok(
    dry.confGrid[0] < base.confGrid[0],
    `SAR dry both sides weakens (${dry.confGrid[0]} < ${base.confGrid[0]})`,
  );
});

test("SAR: standing water at B penalises bare/built; VH rise corroborates", () => {
  const input = bareBuiltInput();
  const base = classifyFused(input);
  const flooded = classifyFused({
    ...input,
    evidence: { sar: sarFixture(16, { waterMaskB: new Uint8Array(16).fill(1) }) },
  });
  assert.equal(flooded.classGrid[0], CLASS.bareBuilt, "SAR never deletes the optical event");
  assert.ok(flooded.confGrid[0] < base.confGrid[0], "flooded penalty");

  const rough = classifyFused({
    ...input,
    evidence: { sar: sarFixture(16, { dVH: new Float32Array(16).fill(1.5) }) },
  });
  assert.ok(
    rough.confGrid[0] > base.confGrid[0],
    `dVH rise corroborates (${rough.confGrid[0]} > ${base.confGrid[0]})`,
  );
});

test("SAR invalid at the pixel → no SAR points (neutral)", () => {
  const input = waterGainInput();
  const base = classifyFused(input);
  const invalid = classifyFused({
    ...input,
    evidence: { sar: sarFixture(16, { valid: new Uint8Array(16) }) },
  });
  assert.equal(invalid.confGrid[0], base.confGrid[0]);
});

/* ------------------------------------------------------------------ */
/* seasonal water + evidence size guards                               */
/* ------------------------------------------------------------------ */

test("monsoon window → seasonal_water_likely sub-label and one step down", () => {
  const input = waterGainInput();
  const base = classifyFused(input);
  const tag = seasonalTag("2026-07-20", "gain");
  assert.equal(tag, "monsoon-greening");
  const seasonal = classifyFused({ ...input, seasonalGainTag: tag });
  assert.equal(seasonal.classGrid[0], CLASS.waterGain);
  assert.equal(seasonal.subGrid[0], SUB.waterGainSeasonal);
  assert.equal(seasonal.confGrid[0], base.confGrid[0] - 10);
});

test("evidence size mismatch throws CDSE_BAD_GRID", () => {
  const input = bareBuiltInput();
  assert.throws(
    () =>
      classifyFused({
        ...input,
        evidence: { shadow: new Uint8Array(7) },
      }),
    (e: unknown) => (e as { code?: string }).code === "CDSE_BAD_GRID",
  );
});

/* ------------------------------------------------------------------ */
/* shape evidence                                                      */
/* ------------------------------------------------------------------ */

test("applyShapeEvidence: compact patch gains confidence, field-strip loses", () => {
  const width = 20;
  const height = 12;
  const n = width * height;
  const classGrid = new Uint8Array(n);
  const labels = new Int32Array(n);
  const confGrid = new Uint8Array(n);
  const tierGrid = new Uint8Array(n);

  // Compact 6×6 block (label 1): Q = 4π·36/144 ≈ 0.785 → +10.
  for (let r = 2; r < 8; r++) {
    for (let c = 2; c < 8; c++) {
      const i = r * width + c;
      classGrid[i] = CLASS.bareBuilt;
      labels[i] = 1;
      confGrid[i] = 70;
      tierGrid[i] = tierFromConf(70);
    }
  }
  // Long 12×1 strip (label 2): Q = 4π·12/676 ≈ 0.22 → −10.
  for (let c = 4; c < 16; c++) {
    const i = 10 * width + c;
    classGrid[i] = CLASS.bareBuilt;
    labels[i] = 2;
    confGrid[i] = 80;
    tierGrid[i] = tierFromConf(80);
  }

  applyShapeEvidence({ classGrid, labels, confGrid, tierGrid, width, height });

  assert.equal(confGrid[2 * width + 2], 80, "compact +10");
  assert.equal(tierGrid[2 * width + 2], TIER.high, "70 → 80 crosses into high");
  assert.equal(confGrid[10 * width + 4], 70, "strip −10");
  assert.equal(tierGrid[10 * width + 4], TIER.medium, "80 → 70 drops out of high");
});

test("applyShapeEvidence: only bare/built patches are nudged", () => {
  const width = 8;
  const height = 8;
  const n = width * height;
  const classGrid = new Uint8Array(n).fill(CLASS.vegLoss);
  const labels = new Int32Array(n).fill(1);
  const confGrid = new Uint8Array(n).fill(70);
  const tierGrid = new Uint8Array(n).fill(TIER.medium);
  applyShapeEvidence({ classGrid, labels, confGrid, tierGrid, width, height });
  assert.equal(confGrid[0], 70, "veg patch untouched");
});

/* ------------------------------------------------------------------ */
/* PU budget + env + cache key                                         */
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
    areaName: "PU check",
    areaLevel: "tehsil",
    areaId: "pu-check",
    sensitivity: "medium",
    engine: "v2",
    inputMode: "composite",
    compositeWindowDays: 7,
    ...over,
  };
}

test("prepareCompare: fused evidencePlan adds S1 + DEM PU to the estimate", () => {
  const optical = prepareCompare(puInput({ rules: "legacy" }));
  const fused = prepareCompare(
    puInput({ rules: "fused", evidencePlan: { s1WindowDays: 6, terrain: true } }),
  );
  assert.ok(
    fused.estimatedPu > optical.estimatedPu,
    `evidence adds PU (${fused.estimatedPu} > ${optical.estimatedPu})`,
  );
  // S1 off (window null) but terrain on → still above optical-only.
  const noS1 = prepareCompare(
    puInput({ rules: "fused", evidencePlan: { s1WindowDays: null, terrain: true } }),
  );
  assert.ok(noS1.estimatedPu > optical.estimatedPu);
  assert.ok(noS1.estimatedPu < fused.estimatedPu, "S1 contributes its two renders");
});

test("resolveChangeRules: fused forces v2; legacy honours CHANGE_ENGINE", () => {
  assert.deepEqual(resolveChangeRules({ CHANGE_RULES: "fused", CHANGE_ENGINE: "v1" }), {
    rules: "fused",
    engine: "v2",
  });
  assert.deepEqual(resolveChangeRules({ CHANGE_RULES: "legacy", CHANGE_ENGINE: "v1" }), {
    rules: "legacy",
    engine: "v1",
  });
  assert.deepEqual(resolveChangeRules({ CHANGE_RULES: "legacy", CHANGE_ENGINE: "v2" }), {
    rules: "legacy",
    engine: "v2",
  });
});

test("compareCacheKey: rules, S1 window and WorldCover flip the key", () => {
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
    rules: "fused",
    s1WindowDays: 6,
    worldCover: 1,
  };
  const k = compareCacheKey(base);
  assert.notEqual(k, compareCacheKey({ ...base, rules: "legacy" }));
  assert.notEqual(k, compareCacheKey({ ...base, s1WindowDays: 0 }));
  assert.notEqual(k, compareCacheKey({ ...base, worldCover: 0 }));
  assert.equal(k, compareCacheKey({ ...base }), "stable");
});

/* ------------------------------------------------------------------ */
/* processCompare integration (fused rules end-to-end)                  */
/* ------------------------------------------------------------------ */

test("processCompare: rules=fused runs the fused classifier + evidence meta", () => {
  const input = puInput({
    rules: "fused",
    evidencePlan: { s1WindowDays: 6, terrain: true },
    maxPx: 64,
  });
  const prep = prepareCompare(input);
  const { width, height } = prep;

  // A/B composites: background veg; a centre block bare → built.
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
    { parsedA: side("a"), parsedB: side("b") },
    evidence,
  );
  const meta = artifact.result.metadata;
  assert.equal(meta.rules, "fused");
  assert.equal(meta.engine, "v2");
  assert.ok(meta.evidence, "evidence meta present");
  assert.deepEqual(meta.evidence.s1, { skipped: "no-common-orbit" });
  assert.equal(meta.evidence.worldCover, true);
  assert.equal(meta.evidence.terrain, true);
  assert.equal(meta.evidence.demInstance, "COPERNICUS_30");
  assert.ok(meta.estimatedPu > 0);

  // The block was detected; prior cropland re-tagged it as bare_agri.
  let detected = 0;
  for (let i = 0; i < artifact.classGrid.length; i++) {
    if (artifact.classGrid[i] === CLASS.bareBuilt) detected += 1;
  }
  assert.ok(detected > 0, `bare/built block detected (${detected} px)`);
  const events = artifact.patchVectors.features;
  assert.ok(events.length > 0, "events vectorized");
  const props = events[0].properties as Record<string, unknown>;
  assert.equal(props.classCode, CLASS.bareBuilt);
  assert.equal(props.subLabel, "Bare soil on cropland (likely harvest / tillage)");
  assert.equal(typeof props.confidencePct, "number");
  assert.ok(
    (props.confidencePct as number) >= 0 && (props.confidencePct as number) <= 100,
  );
  // Prior-crop penalty caps confidence below the unpenalised maximum.
  assert.ok((props.confidencePct as number) < 100, "crop penalty visible in event conf");
});
