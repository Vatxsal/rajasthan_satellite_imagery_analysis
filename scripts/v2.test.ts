import assert from "node:assert/strict";
import test from "node:test";
import {
  ADAPTIVE_SCALE_MAX,
  ADAPTIVE_SCALE_MIN,
  CLASS,
  SUB,
  scaledThresholds,
  seasonalTag,
} from "../lib/analysis/config";
import type { V2Indices } from "../lib/analysis/v2";
import {
  PERSIST,
  TIER,
  adaptiveThresholds,
  applyShift,
  classifyV2,
  deriveV2Indices,
  estimateShift,
  normalizeBands,
} from "../lib/analysis/v2";

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

function bands(n: number, offset = 0) {
  return {
    b02: new Float32Array(n).fill(0.1 + offset),
    b03: new Float32Array(n).fill(0.3 + offset),
    b04: new Float32Array(n).fill(0.2 + offset),
    b05: new Float32Array(n).fill(0.05 + offset),
    b08: new Float32Array(n).fill(0.6 + offset),
    b11: new Float32Array(n).fill(0.1 + offset),
    b12: new Float32Array(n).fill(0.05 + offset),
  };
}

test("deriveV2Indices: parity trio + extended indices + zero-denominator convention", () => {
  const idx = deriveV2Indices(bands(2));
  assert.ok(Math.abs(idx.ndvi[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(idx.mndwi[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(idx.ndbi[0] - (0.1 - 0.6) / 0.7) < 1e-6);
  assert.ok(Math.abs(idx.ndmi[0] - (0.6 - 0.1) / 0.7) < 1e-6);
  assert.ok(Math.abs(idx.ndwi[0] - (0.3 - 0.6) / 0.9) < 1e-6);
  // BSI = ((0.1+0.2)-(0.6+0.1))/((0.1+0.2)+(0.6+0.1)) = -0.4/1.0
  assert.ok(Math.abs(idx.bsi[0] - -0.4) < 1e-6);
  // AWEIsh = 4(0.3-0.1) − (0.25·0.6 + 0.75·0.2) = 0.8 − 0.3
  assert.ok(Math.abs(idx.awei[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(idx.brightness[0] - (0.1 + 0.3 + 0.2 + 0.05 + 0.6 + 0.1 + 0.05) / 7) < 1e-6);
  assert.ok(Math.abs(idx.nbr[0] - (0.6 - 0.05) / 0.65) < 1e-6);
  // vBare = (0.1−0.3)/(0.1+0.3); vBright = (0.1+0.3+0.2)/3
  assert.ok(Math.abs(idx.vBare[0] - -0.5) < 1e-6);
  assert.ok(Math.abs(idx.vBright[0] - 0.2) < 1e-6);

  // All-zero bands → every ratio index 0 (v1 convention).
  const empty = deriveV2Indices({
    b02: new Float32Array(1),
    b03: new Float32Array(1),
    b04: new Float32Array(1),
    b05: new Float32Array(1),
    b08: new Float32Array(1),
    b11: new Float32Array(1),
    b12: new Float32Array(1),
  });
  for (const [key, arr] of Object.entries(empty)) {
    if (key === "awei" || key === "brightness") continue;
    assert.equal(arr[0], 0, `${key} of all-zero bands`);
  }
});

test("normalizeBands: median matching applied, clamped, or skipped", () => {
  const n = 2500;
  const mask = new Uint8Array(n).fill(1);

  // Small offset → applied as-is.
  const a1 = bands(n);
  const b1 = bands(n, 0.02);
  const r1 = normalizeBands(a1, b1, mask);
  assert.equal(r1.appliedBands, 7);
  assert.equal(r1.skippedBands, 0);
  assert.ok(Math.abs(r1.maxShift - 0.02) < 1e-5);
  assert.ok(Math.abs(a1.b04[10] - b1.b04[10]) < 1e-5, "A median-matched onto B");

  // Large offset → treated as seasonal signal, band skipped.
  const a2 = bands(n);
  const before = Float32Array.from(a2.b04);
  const b2 = bands(n, 0.2);
  const r2 = normalizeBands(a2, b2, mask);
  assert.equal(r2.appliedBands, 0);
  assert.equal(r2.skippedBands, 7);
  assert.deepEqual(Array.from(a2.b04), Array.from(before), "skipped bands untouched");

  // Mid offset → clamped to the hard cap.
  const a3 = bands(n);
  const b3 = bands(n, 0.06);
  const r3 = normalizeBands(a3, b3, mask);
  assert.equal(r3.appliedBands, 7);
  assert.ok(Math.abs(r3.maxShift - 0.04) < 1e-5, "clamped to 0.04");
});

test("co-registration: detects a planted shift, leaves aligned input alone", () => {
  const W = 40;
  const H = 40;
  const n = W * H;
  const mask = new Uint8Array(n).fill(1);
  const clamp = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : v);

  // Deterministic pseudo-random pattern (structure for the NCC).
  const pattern = () => {
    let seed = 42;
    const p = bands(n);
    for (let i = 0; i < n; i++) {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      p.b04[i] = seed / 4294967296;
    }
    return p;
  };

  // B = A sampled at (row+dy0, col+dx0) → estimate must recover the shift.
  const dx0 = 2;
  const dy0 = 1;
  const a = pattern();
  const bPlanted = { ...bands(n), b04: new Float32Array(n) };
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      bPlanted.b04[row * W + col] = a.b04[clamp(row + dy0, H - 1) * W + clamp(col + dx0, W - 1)];
    }
  }
  const planted = estimateShift(a, bPlanted, mask, W, H);
  assert.equal(planted.applied, true);
  assert.equal(planted.dx, dx0);
  assert.equal(planted.dy, dy0);

  applyShift(a, mask, planted.dx, planted.dy, W, H);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(a.b04[i] - bPlanted.b04[i]) < 1e-6, `aligned at ${i}`);
  }

  // Identical content → no shift.
  const aligned = estimateShift(pattern(), pattern(), mask, W, H);
  assert.equal(aligned.applied, false);
  assert.equal(aligned.dx, 0);
  assert.equal(aligned.dy, 0);
});

test("adaptiveThresholds: robust sigma drives the clamped scale", () => {
  const n = 4900;
  const valid = new Uint8Array(n).fill(1);
  const base = scaledThresholds("medium");

  // Tiny noise → scale floors at ADAPTIVE_SCALE_MIN.
  const aClean = zeroIndices(n);
  const bClean = zeroIndices(n);
  for (let i = 0; i < n; i++) bClean.ndvi[i] = i % 2 ? 0.001 : -0.001;
  const clean = adaptiveThresholds(aClean, bClean, valid, base);
  assert.equal(clean.scales.ndvi, ADAPTIVE_SCALE_MIN);
  assert.ok(Math.abs(clean.t.vegLossD - base.vegLossD * ADAPTIVE_SCALE_MIN) < 1e-6);

  // Huge noise → scale caps at ADAPTIVE_SCALE_MAX on every driver.
  const aNoisy = zeroIndices(n);
  const bNoisy = zeroIndices(n);
  for (let i = 0; i < n; i++) {
    bNoisy.ndvi[i] = i % 2 ? 0.3 : -0.3;
    bNoisy.mndwi[i] = i % 2 ? 0.3 : -0.3;
    bNoisy.ndbi[i] = i % 2 ? 0.3 : -0.3;
    bNoisy.bsi[i] = i % 2 ? 0.3 : -0.3;
  }
  const noisy = adaptiveThresholds(aNoisy, bNoisy, valid, base);
  assert.equal(noisy.scales.ndvi, ADAPTIVE_SCALE_MAX);
  assert.equal(noisy.scales.mndwi, ADAPTIVE_SCALE_MAX);
  assert.ok(noisy.sigma.ndvi > 0.1, "sigma reported");
  assert.ok(Math.abs(noisy.t.vegLossD - base.vegLossD * ADAPTIVE_SCALE_MAX) < 1e-6);
  // State gates must NOT be scaled.
  assert.equal(noisy.t.bareBuiltMaxMndwi, base.bareBuiltMaxMndwi);
  assert.equal(noisy.t.waterGainMndwiMin, base.waterGainMndwiMin);
});

interface Scenario {
  input: Parameters<typeof classifyV2>[0];
}

function scenario(over: Partial<Parameters<typeof classifyV2>[0]>): Scenario {
  const n = 16;
  const t = scaledThresholds("medium");
  return {
    input: {
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
    },
  };
}

test("classifyV2: 3-vote persistent veg loss → high tier, cleared sub-label", () => {
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
  const aRecent = { ndvi: new Float32Array(n).fill(0.6), mndwi: new Float32Array(n).fill(-0.1), ndbi: new Float32Array(n) };
  const bRecent = { ndvi: new Float32Array(n).fill(0.28), mndwi: new Float32Array(n).fill(-0.1), ndbi: new Float32Array(n) };

  const { input } = scenario({ a, b, aRecent, bRecent });
  const out = classifyV2(input);
  assert.equal(out.classGrid[0], CLASS.vegLoss);
  assert.equal(out.subGrid[0], SUB.vegLossCleared);
  assert.equal(out.tierGrid[0], TIER.high);
  assert.equal(out.persistGrid[0], PERSIST.yes);
  assert.equal(out.changePixels, n);
  assert.ok(out.cvaMean >= 2.5);
  assert.equal(out.persistentPixels, n);
});

test("classifyV2: harvest window → crop-cycle sub-label and one tier down", () => {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.ndvi.fill(0.6);
  b.ndvi.fill(0.3);
  a.ndmi.fill(0.4);
  b.ndmi.fill(0.15);
  a.bsi.fill(-0.2);
  b.bsi.fill(0.0);
  const aRecent = { ndvi: new Float32Array(n).fill(0.6), mndwi: new Float32Array(n), ndbi: new Float32Array(n) };
  const bRecent = { ndvi: new Float32Array(n).fill(0.28), mndwi: new Float32Array(n), ndbi: new Float32Array(n) };

  const tag = seasonalTag("2026-10-20", "loss");
  assert.equal(tag, "kharif-harvest");
  const { input } = scenario({ a, b, aRecent, bRecent, seasonalLossTag: tag });
  const out = classifyV2(input);
  assert.equal(out.classGrid[0], CLASS.vegLoss);
  assert.equal(out.subGrid[0], SUB.vegLossHarvest);
  assert.equal(out.tierGrid[0], TIER.medium, "seasonal penalty drops high → medium");
});

test("classifyV2: transient water gain → low tier, ponding sub-label", () => {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.mndwi.fill(-0.1);
  b.mndwi.fill(0.2);
  a.ndwi.fill(-0.05);
  b.ndwi.fill(0.25);
  b.awei.fill(0.15);
  const bRecent = { ndvi: new Float32Array(n), mndwi: Float32Array.from(a.mndwi, (v) => v + 0.01), ndbi: new Float32Array(n) };
  const aRecent = { ndvi: new Float32Array(n), mndwi: Float32Array.from(a.mndwi), ndbi: new Float32Array(n) };

  const { input } = scenario({ a, b, aRecent, bRecent });
  const out = classifyV2(input);
  assert.equal(out.classGrid[0], CLASS.waterGain);
  assert.equal(out.subGrid[0], SUB.waterGainPonding);
  assert.equal(out.persistGrid[0], PERSIST.transient);
  assert.equal(out.tierGrid[0], TIER.low, "3 votes − transient − no CVA boost → low");
  assert.equal(out.transientPixels, n);
});

test("classifyV2: bare/built anchor+support beats the sub-threshold veg dip", () => {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.ndvi.fill(0.5);
  b.ndvi.fill(0.42); // −0.08: above veg-loss threshold, inside bare/built gate
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
  const aRecent = { ndvi: new Float32Array(n).fill(0.5), mndwi: Float32Array.from(a.mndwi), ndbi: Float32Array.from(a.ndbi) };
  const bRecent = { ndvi: new Float32Array(n).fill(0.42), mndwi: Float32Array.from(b.mndwi), ndbi: Float32Array.from(a.ndbi, (v) => v + 0.14) };

  const { input } = scenario({ a, b, aRecent, bRecent });
  const out = classifyV2(input);
  assert.equal(out.classGrid[0], CLASS.bareBuilt);
  assert.equal(out.subGrid[0], SUB.bareBuiltConstruction);
  assert.equal(out.persistGrid[0], PERSIST.yes);
});

test("classifyV2: short gap costs vegetation a confidence step", () => {
  const n = 16;
  const a = zeroIndices(n);
  const b = zeroIndices(n);
  a.ndvi.fill(0.6);
  b.ndvi.fill(0.3);
  a.ndmi.fill(0.4);
  b.ndmi.fill(0.15);
  a.bsi.fill(-0.2);
  b.bsi.fill(0.0);
  const aRecent = { ndvi: new Float32Array(n).fill(0.6), mndwi: new Float32Array(n), ndbi: new Float32Array(n) };
  const bRecent = { ndvi: new Float32Array(n).fill(0.28), mndwi: new Float32Array(n), ndbi: new Float32Array(n) };

  const base = scenario({ a, b, aRecent, bRecent });
  assert.equal(classifyV2(base.input).tierGrid[0], TIER.high);
  const short = scenario({ a, b, aRecent, bRecent, shortGap: true });
  assert.equal(classifyV2(short.input).tierGrid[0], TIER.medium);
});

test("classifyV2: no-change, masked and outside pixels carry no tier", () => {
  const { input } = scenario({});
  input.inside[0] = 0;
  input.valid[1] = 0;
  const out = classifyV2(input);
  assert.equal(out.classGrid[0], CLASS.outside);
  assert.equal(out.classGrid[1], CLASS.masked);
  assert.equal(out.classGrid[2], CLASS.noChange);
  assert.equal(out.tierGrid[0], 0);
  assert.equal(out.tierGrid[1], 0);
  assert.equal(out.changePixels, 0);
  assert.equal(out.cvaMean, 0);
});

test("seasonalTag: Rajasthan kharif/rabi/monsoon windows", () => {
  assert.equal(seasonalTag("2026-10-20", "loss"), "kharif-harvest");
  assert.equal(seasonalTag("2026-04-05", "loss"), "rabi-harvest");
  assert.equal(seasonalTag("2026-07-01", "gain"), "monsoon-greening");
  assert.equal(seasonalTag("2026-01-15", "loss"), null);
  assert.equal(seasonalTag("2026-12-20", "loss"), null);
  assert.equal(seasonalTag("2026-10-20", "gain"), null, "harvest windows never tag gains");
});
