/**
 * Phase 3 — fused change rules (CHANGE_RULES=fused).
 *
 * Runs on the v2 machinery (multi-index vote, CVA, persistence, seasonal
 * context, confidence tiers) and adds three evidence streams the legacy
 * rules never see:
 *
 *   1. Sentinel-1 GRD (Phase 1) — SAR water-mask transitions corroborate or
 *      weaken water votes; a VH rise corroborates roughening for bare/built.
 *      SAR NEVER creates a built-up event on its own (crops/soil moisture
 *      confound — s1.ts LIMITS): optical agreement stays required.
 *   2. ESA WorldCover prior (Phase 2) — pixels already class 50 before date A
 *      cannot become NEW built-up (suppressed); class 40 (cropland) re-tags
 *      bare/built as bare_agri with a confidence penalty; class 80 before
 *      date A cannot "gain" water (suppressed).
 *   3. Terrain (Phase 2) — hillshade shadow masks delete candidate water:
 *      radar-shadow and SWIR-shadow bands mimic open water in both SAR and
 *      MNDWI. (Dilated SCL cloud/shadow removal is already in `valid`.)
 *
 * Confidence: 0-100 = clamp(40 + 10·score, 0, 100) where score is the v2
 * point system plus FUSED evidence points; tiers cut at FUSED.confHigh /
 * confMedium (75/55) — with no evidence these reproduce the v2 cut-points
 * exactly, so `classifyFused` ≡ `classifyV2` on class/tier grids when every
 * evidence stream is absent (enforced by an equivalence test).
 *
 * Bare/built sub-labels under fused: possible_builtup | bare_surface |
 * bare_agri — never "confirmed". Post-classification, `applyShapeEvidence`
 * nudges bare/built patch confidence by patch compactness (Q = 4πA/P²):
 * compact construction-like outlines gain points, long field-strips lose them.
 */
import { CLASS, FUSED, SUB, VOTE } from "./config";
import {
  PERSIST,
  TIER,
  type ClassifyV2Input,
  type ClassifyV2Output,
} from "./v2/classify";
import {
  priorIsBuiltup,
  priorIsCropland,
  priorIsWater,
  type WorldCoverPrior,
} from "./prior";
import type { SarFeatures } from "./s1";

const VOTE_CORROB = VOTE.corrobFactor;
const AWEI_CORROB = VOTE.aweiCorrob;
const BRIGHT_CORROB = VOTE.brightCorrob;
const CVA_BOOST = VOTE.cvaBoost;
const PERSIST_FACTOR = VOTE.persistFactor;
const SAR_WATER_AGREE = FUSED.sarWaterAgree;
const SAR_WATER_DISAGREE = FUSED.sarWaterDisagree;
const SAR_FLOODED = FUSED.sarFloodedPenalty;
const SAR_BUILT_DVH = FUSED.sarBuiltDvhDb;
const PRIOR_CROP = FUSED.priorCropPenalty;

/** Optional evidence streams; null/absent = stream off (graceful). */
export interface FusedEvidence {
  sar?: SarFeatures | null;
  prior?: WorldCoverPrior | null;
  /** TerrainGrids.shadow — 1 = hillshade below the shadow threshold. */
  shadow?: Uint8Array | null;
}

export interface ClassifyFusedInput extends ClassifyV2Input {
  evidence?: FusedEvidence;
}

export interface ClassifyFusedOutput extends ClassifyV2Output {
  /** 0-100 confidence per change pixel; 0 elsewhere (uint8 grid). */
  confGrid: Uint8Array;
}

/** v2 confidence points → 0-100 (monotonic, clamped). */
export function confFromScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(40 + 10 * score)));
}

/** 0-100 confidence → tier (reproduces the v2 score cut-points). */
export function tierFromConf(conf: number): number {
  return conf >= FUSED.confHigh ? TIER.high : conf >= FUSED.confMedium ? TIER.medium : TIER.low;
}

function checkLen(name: string, arr: { length: number }, n: number): void {
  if (arr.length !== n) {
    throw Object.assign(new Error(`fused evidence ${name}: size mismatch ${arr.length} vs ${n}`), {
      status: 502,
      code: "CDSE_BAD_GRID",
    });
  }
}

export function classifyFused(input: ClassifyFusedInput): ClassifyFusedOutput {
  const { a, b, aRecent, bRecent, valid, inside, t, scales } = input;
  const n = valid.length;
  const ev = input.evidence ?? {};
  const sar = ev.sar ?? null;
  const prior = ev.prior ?? null;
  const shadow = ev.shadow ?? null;
  if (sar) {
    checkLen("sar.valid", sar.valid, n);
    checkLen("sar.waterMaskA", sar.waterMaskA, n);
    checkLen("sar.waterMaskB", sar.waterMaskB, n);
  }
  if (prior) checkLen("prior.cls", prior.cls, n);
  if (shadow) checkLen("terrain.shadow", shadow, n);

  const classGrid = new Uint8Array(n);
  const subGrid = new Uint8Array(n);
  const tierGrid = new Uint8Array(n);
  const persistGrid = new Uint8Array(n);
  const confGrid = new Uint8Array(n);

  const f = VOTE_CORROB;
  const aweiT = AWEI_CORROB * scales.mndwi;
  const brightT = BRIGHT_CORROB * scales.ndbi;
  const mNdbi = Math.max(t.bareBuiltD, 1e-6);
  const mNdvi = Math.max(Math.abs(t.vegLossD), 1e-6);
  const mMndwi = Math.max(t.waterGainD, 1e-6);
  const mBsi = Math.max(f * t.bareBuiltD, 1e-6);
  const mNbr = Math.max(Math.abs(t.vegLossD), 1e-6);

  let cvaSum = 0;
  let changePixels = 0;
  let persistentPixels = 0;
  let transientPixels = 0;

  for (let i = 0; i < n; i++) {
    if (inside[i] !== 1) {
      classGrid[i] = CLASS.outside;
      continue;
    }
    if (valid[i] !== 1) {
      classGrid[i] = CLASS.masked;
      continue;
    }

    const dNdvi = b.ndvi[i] - a.ndvi[i];
    const dMndwi = b.mndwi[i] - a.mndwi[i];
    const dNdbi = b.ndbi[i] - a.ndbi[i];
    const dNdmi = b.ndmi[i] - a.ndmi[i];
    const dNdwi = b.ndwi[i] - a.ndwi[i];
    const dBsi = b.bsi[i] - a.bsi[i];
    const dAwei = b.awei[i] - a.awei[i];
    const dBright = b.brightness[i] - a.brightness[i];
    const dNbr = b.nbr[i] - a.nbr[i];
    const dVbare = b.vBare[i] - a.vBare[i];
    const dVbright = b.vBright[i] - a.vBright[i];

    // ── anchor + support vote per class (identical to legacy v2) ───────────
    // 10 m-native anchor (NDWI / NDVI / vBare) required at full threshold,
    // plus ≥1 supporting index; 20 m SWIR-derived indices (MNDWI/AWEI/NDMI/
    // NDBI/BSI) corroborate but never determine a class alone. State gates
    // are unchanged (state checks, not change evidence).
    let code: number = CLASS.noChange;
    let votes = 0;
    let sub: number = 0;

    if (
      b.mndwi[i] > t.waterGainMndwiMin &&
      dNdwi >= f * t.waterGainD &&
      (dMndwi >= t.waterGainD || dAwei >= aweiT)
    ) {
      code = CLASS.waterGain;
      votes =
        1 +
        (dMndwi >= t.waterGainD ? 1 : 0) +
        (dAwei >= aweiT ? 1 : 0);
    } else if (
      a.mndwi[i] > t.waterLossMndwiMin &&
      dNdwi <= f * t.waterLossD &&
      (dMndwi <= t.waterLossD || dAwei <= -aweiT)
    ) {
      code = CLASS.waterLoss;
      votes =
        1 +
        (dMndwi <= t.waterLossD ? 1 : 0) +
        (dAwei <= -aweiT ? 1 : 0);
    } else if (
      dNdvi <= t.vegLossD &&
      (dNdmi <= f * t.vegLossD || dBsi >= f * Math.abs(t.vegLossD))
    ) {
      code = CLASS.vegLoss;
      votes =
        1 +
        (dNdmi <= f * t.vegLossD ? 1 : 0) +
        (dBsi >= f * Math.abs(t.vegLossD) ? 1 : 0);
    } else if (
      dNdvi >= t.vegGainD &&
      (dNdmi >= f * t.vegGainD || dBsi <= -f * t.vegGainD)
    ) {
      code = CLASS.vegGain;
      votes =
        1 +
        (dNdmi >= f * t.vegGainD ? 1 : 0) +
        (dBsi <= -f * t.vegGainD ? 1 : 0);
    } else if (
      dNdvi <= t.bareBuiltNdviMax &&
      a.mndwi[i] <= t.bareBuiltMaxMndwi &&
      b.mndwi[i] <= t.bareBuiltMaxMndwi &&
      dVbare >= f * t.bareBuiltD &&
      (dVbright >= brightT || dNdbi >= t.bareBuiltD || dBsi >= f * t.bareBuiltD)
    ) {
      code = CLASS.bareBuilt;
      votes =
        1 +
        (dVbright >= brightT ? 1 : 0) +
        (dNdbi >= t.bareBuiltD ? 1 : 0) +
        (dBsi >= f * t.bareBuiltD ? 1 : 0);
    }

    if (code === CLASS.noChange) continue;

    // ── evidence suppression (before anything is counted) ──────────────────
    if (
      (code === CLASS.waterGain || code === CLASS.waterLoss) &&
      shadow &&
      shadow[i] === 1
    ) {
      continue; // terrain shadow mimics water in SAR + SWIR
    }
    if (code === CLASS.waterGain && prior && priorIsWater(prior, i)) {
      continue; // already permanent water before date A (WorldCover 80)
    }
    if (code === CLASS.bareBuilt && prior && priorIsBuiltup(prior, i)) {
      continue; // already built-up before date A (WorldCover 50) — not NEW
    }

    // ── persistence: recent-orbit Δ agrees with the composite Δ (v2) ───────
    let primaryDelta: number;
    let primaryThreshold: number;
    let recentDelta: number;
    switch (code) {
      case CLASS.waterGain:
        primaryDelta = dMndwi;
        primaryThreshold = t.waterGainD;
        recentDelta = bRecent.mndwi[i] - a.mndwi[i];
        break;
      case CLASS.waterLoss:
        primaryDelta = dMndwi;
        primaryThreshold = t.waterLossD;
        recentDelta = bRecent.mndwi[i] - a.mndwi[i];
        break;
      case CLASS.bareBuilt:
        primaryDelta = dNdbi;
        primaryThreshold = t.bareBuiltD;
        recentDelta = bRecent.ndbi[i] - a.ndbi[i];
        break;
      default:
        primaryDelta = dNdvi;
        primaryThreshold = code === CLASS.vegLoss ? t.vegLossD : t.vegGainD;
        recentDelta = bRecent.ndvi[i] - a.ndvi[i];
    }
    const signOk =
      primaryDelta !== 0 && Math.sign(recentDelta) === Math.sign(primaryDelta);
    const aStable =
      Math.abs(aRecentVal(code, aRecent, i) - driverVal(a, code, i)) <
      Math.abs(primaryThreshold);
    const persistent =
      signOk &&
      aStable &&
      Math.abs(recentDelta) >= PERSIST_FACTOR * Math.abs(primaryThreshold);
    persistGrid[i] = persistent ? PERSIST.yes : PERSIST.transient;
    if (persistent) persistentPixels += 1;
    else transientPixels += 1;

    // ── CVA magnitude in threshold units (v2 formula) ──────────────────────
    const norm = (d: number, m: number): number => Math.max(-10, Math.min(10, d / m));
    const cva = Math.sqrt(
      norm(dNdvi, mNdvi) ** 2 +
        norm(dMndwi, mMndwi) ** 2 +
        norm(dNdbi, mNdbi) ** 2 +
        norm(dBsi, mBsi) ** 2 +
        norm(dNbr, mNbr) ** 2,
    );

    // ── sub-label ──────────────────────────────────────────────────────────
    let seasonal = false;
    switch (code) {
      case CLASS.waterGain:
        if (input.seasonalGainTag) {
          sub = SUB.waterGainSeasonal; // monsoon window — seasonal likely
          seasonal = true;
        } else {
          sub = persistent ? SUB.waterGainNew : SUB.waterGainPonding;
        }
        break;
      case CLASS.waterLoss:
        sub = persistent ? SUB.waterLossReceded : SUB.waterLossDrawdown;
        break;
      case CLASS.vegLoss:
        if (input.seasonalLossTag) {
          sub = SUB.vegLossHarvest;
          seasonal = true;
        } else if (dBsi >= f * Math.abs(t.vegLossD) || dBright >= brightT) {
          sub = SUB.vegLossCleared;
        } else {
          sub = SUB.vegLossStress;
        }
        break;
      case CLASS.vegGain:
        if (input.seasonalGainTag) {
          sub = SUB.vegGainSeasonal;
          seasonal = true;
        } else {
          sub = SUB.vegGainRecovery;
        }
        break;
      case CLASS.bareBuilt: {
        const crop = prior ? priorIsCropland(prior, i) : false;
        if (crop) {
          sub = SUB.bareBuiltAgriculture; // harvest/tillage, not construction
        } else if (votes === 4 && persistent && dBright > 0) {
          sub = SUB.bareBuiltPossible;
        } else {
          sub = SUB.bareBuiltSurface;
        }
        break;
      }
    }

    // ── confidence score: v2 points + fused evidence points ────────────────
    // votes ≥ 3 (of 3 for water/veg, of 4 for bare/built) = full agreement.
    let score = votes >= 3 ? 2 : 1;
    if (cva >= CVA_BOOST) score += 1;
    score += persistent ? 1 : -1;
    if (seasonal) score -= 1;
    if (input.shortGap && (code === CLASS.vegLoss || code === CLASS.vegGain)) score -= 1;

    // SAR evidence (only where both sides have a valid observation).
    if (sar && sar.valid[i] === 1) {
      const wa = sar.waterMaskA[i] === 1;
      const wb = sar.waterMaskB[i] === 1;
      if (code === CLASS.waterGain) {
        score += !wa && wb ? SAR_WATER_AGREE : !wa && !wb ? SAR_WATER_DISAGREE : 0;
      } else if (code === CLASS.waterLoss) {
        score += wa && !wb ? SAR_WATER_AGREE : !wa && !wb ? SAR_WATER_DISAGREE : 0;
      } else if (code === CLASS.bareBuilt) {
        if (wb) score += SAR_FLOODED; // standing water at B ≠ construction
        else if (sar.dVH[i] >= SAR_BUILT_DVH) score += 1; // roughening corroboration
      }
    }
    // WorldCover cropland penalty (bare/built only — the rest is unchanged).
    if (code === CLASS.bareBuilt && prior && prior.valid[i] === 1 && priorIsCropland(prior, i)) {
      score += PRIOR_CROP;
    }

    const conf = confFromScore(score);
    tierGrid[i] = tierFromConf(conf);
    confGrid[i] = conf;
    subGrid[i] = sub;
    classGrid[i] = code;
    changePixels += 1;
    cvaSum += cva;
  }

  return {
    classGrid,
    subGrid,
    tierGrid,
    persistGrid,
    confGrid,
    cvaMean: changePixels > 0 ? cvaSum / changePixels : 0,
    changePixels,
    persistentPixels,
    transientPixels,
  };
}

/* ------------------------------------------------------------------ */
/* shape evidence (post-label pass)                                     */
/* ------------------------------------------------------------------ */

/**
 * Patch-shape nudge for bare/built confidence (run after labelPatches):
 * Q = 4πA/P² (px units) — compact construction-like outlines gain
 * FUSED.shapeDelta points, long field-strips lose them. Adjusts confGrid
 * and re-derives tiers in place; sub-labels are NOT changed here.
 */
export function applyShapeEvidence(args: {
  classGrid: Uint8Array;
  labels: Int32Array;
  confGrid: Uint8Array;
  tierGrid: Uint8Array;
  width: number;
  height: number;
}): void {
  const { classGrid, labels, confGrid, tierGrid, width, height } = args;
  const n = labels.length;
  // Per-label area + perimeter (4-neighbour, patch∉ → edge).
  const area = new Map<number, number>();
  const perim = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const label = labels[i];
    if (label === 0) continue;
    area.set(label, (area.get(label) ?? 0) + 1);
    const col = i % width;
    const row = (i - col) / width;
    let edges = 0;
    if (col === 0 || labels[i - 1] !== label) edges += 1;
    if (col === width - 1 || labels[i + 1] !== label) edges += 1;
    if (row === 0 || labels[i - width] !== label) edges += 1;
    if (row === height - 1 || labels[i + width] !== label) edges += 1;
    perim.set(label, (perim.get(label) ?? 0) + edges);
  }
  for (let i = 0; i < n; i++) {
    const label = labels[i];
    if (label === 0 || classGrid[i] !== CLASS.bareBuilt) continue;
    const a = area.get(label) ?? 0;
    const p = perim.get(label) ?? 0;
    if (a === 0 || p === 0) continue;
    const q = (4 * Math.PI * a) / (p * p);
    const delta =
      q >= FUSED.shapeCompactHigh ? FUSED.shapeDelta : q <= FUSED.shapeCompactLow ? -FUSED.shapeDelta : 0;
    if (delta === 0) continue;
    // Called once per run — add the nudge to every pixel of this patch.
    const conf = Math.max(0, Math.min(100, confGrid[i] + delta));
    confGrid[i] = conf;
    tierGrid[i] = tierFromConf(conf);
  }
}

/** A's median driver index for the class (A-side stability check, v2). */
function driverVal(a: ClassifyV2Input["a"], code: number, i: number): number {
  if (code === CLASS.waterGain || code === CLASS.waterLoss) return a.mndwi[i];
  if (code === CLASS.bareBuilt) return a.ndbi[i];
  return a.ndvi[i];
}

/** A's recent-orbit driver index for the class (v2). */
function aRecentVal(
  code: number,
  aRecent: ClassifyV2Input["aRecent"],
  i: number,
): number {
  if (code === CLASS.waterGain || code === CLASS.waterLoss) return aRecent.mndwi[i];
  if (code === CLASS.bareBuilt) return aRecent.ndbi[i];
  return aRecent.ndvi[i];
}
