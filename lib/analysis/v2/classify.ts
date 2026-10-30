/**
 * Phase 2.5/2.6/2.7/2.8 — the v2 pixel classifier.
 *
 * Replaces the single-index gates of v1 with a multi-index vote: each class
 * has a primary Δ-index plus two corroborating indices; a class needs 2 of 3
 * votes (and its state gates) and keeps the v1 precedence order. Every change
 * pixel additionally gets:
 *
 *  - CVA magnitude (normalised index-change energy) → confidence points
 *  - persistence (recent-orbit Δ agrees with the composite Δ, §2.7)
 *  - a sub-label (harvest vs clearing, ponding vs new water, …, §2.5/2.6)
 *  - a confidence tier high/medium/low (§2.8) — no pixel is ever "confirmed"
 */
import {
  CLASS,
  SUB,
  VOTE,
  type ScaledThresholds,
  type SeasonalTag,
} from "../config";
import type { RecentIndices, V2Indices } from "./indices";

/** Confidence tier codes (grid values; text tiers map 1→low, 2→medium, 3→high). */
export const TIER = { none: 0, low: 1, medium: 2, high: 3 } as const;
/** Persistence codes: 0 = n/a, 1 = recent orbit agrees, 2 = disagrees (transient). */
export const PERSIST = { none: 0, yes: 1, transient: 2 } as const;

export interface ClassifyV2Input {
  a: V2Indices;
  b: V2Indices;
  aRecent: RecentIndices;
  bRecent: RecentIndices;
  /** Combined validity (post-dilation). */
  valid: Uint8Array;
  inside: Uint8Array;
  /** Adaptive effective thresholds (v2/thresholds.ts). */
  t: ScaledThresholds;
  /** Adaptive scales per index (v2/thresholds.ts). */
  scales: Record<string, number>;
  /** seasonalTag(dateB, "loss") — crop-cycle context for vegetation loss. */
  seasonalLossTag: SeasonalTag | null;
  /** seasonalTag(dateB, "gain") — crop-cycle context for vegetation gain. */
  seasonalGainTag: SeasonalTag | null;
  /** gapDays < V2_SHORT_GAP_DAYS — vegetation classes lose a confidence step. */
  shortGap: boolean;
}

export interface ClassifyV2Output {
  classGrid: Uint8Array;
  /** SUB codes per pixel (0 = n/a). */
  subGrid: Uint8Array;
  /** TIER codes per pixel (only change pixels carry a tier). */
  tierGrid: Uint8Array;
  /** PERSIST codes per pixel (only change pixels). */
  persistGrid: Uint8Array;
  /** Mean CVA magnitude (threshold units) across change pixels; 0 if none. */
  cvaMean: number;
  changePixels: number;
  persistentPixels: number;
  transientPixels: number;
}

/** Driver index of A's recent orbit for the class (A-side stability check). */
function aRecentVal(code: number, aRecent: RecentIndices, i: number): number {
  if (code === CLASS.waterGain || code === CLASS.waterLoss) return aRecent.mndwi[i];
  if (code === CLASS.bareBuilt) return aRecent.ndbi[i];
  return aRecent.ndvi[i];
}

/** A's median driver index for the class (A-side stability check). */
function driverVal(a: V2Indices, code: number, i: number): number {
  if (code === CLASS.waterGain || code === CLASS.waterLoss) return a.mndwi[i];
  if (code === CLASS.bareBuilt) return a.ndbi[i];
  return a.ndvi[i];
}

export function classifyV2(input: ClassifyV2Input): ClassifyV2Output {
  const { a, b, aRecent, bRecent, valid, inside, t, scales } = input;
  const n = valid.length;
  const classGrid = new Uint8Array(n);
  const subGrid = new Uint8Array(n);
  const tierGrid = new Uint8Array(n);
  const persistGrid = new Uint8Array(n);

  const f = VOTE.corrobFactor;
  const aweiT = VOTE.aweiCorrob * scales.mndwi;
  const brightT = VOTE.brightCorrob * scales.ndbi;
  // CVA normalisers (positive magnitudes of the class thresholds).
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

    // ── 2-of-3 vote per class, v1 precedence order ─────────────────────────
    let code: number = CLASS.noChange;
    let votes = 0;
    let sub: number = 0;

    if (
      b.mndwi[i] > t.waterGainMndwiMin &&
      (dMndwi >= t.waterGainD ? 1 : 0) + (dNdwi >= f * t.waterGainD ? 1 : 0) +
          (dAwei >= aweiT ? 1 : 0) >=
        2
    ) {
      code = CLASS.waterGain;
      votes =
        (dMndwi >= t.waterGainD ? 1 : 0) +
        (dNdwi >= f * t.waterGainD ? 1 : 0) +
        (dAwei >= aweiT ? 1 : 0);
    } else if (
      a.mndwi[i] > t.waterLossMndwiMin &&
      (dMndwi <= t.waterLossD ? 1 : 0) + (dNdwi <= f * t.waterLossD ? 1 : 0) +
          (dAwei <= -aweiT ? 1 : 0) >=
        2
    ) {
      code = CLASS.waterLoss;
      votes =
        (dMndwi <= t.waterLossD ? 1 : 0) +
        (dNdwi <= f * t.waterLossD ? 1 : 0) +
        (dAwei <= -aweiT ? 1 : 0);
    } else if (
      (dNdvi <= t.vegLossD ? 1 : 0) + (dNdmi <= f * t.vegLossD ? 1 : 0) +
        (dBsi >= f * Math.abs(t.vegLossD) ? 1 : 0) >=
      2
    ) {
      code = CLASS.vegLoss;
      votes =
        (dNdvi <= t.vegLossD ? 1 : 0) +
        (dNdmi <= f * t.vegLossD ? 1 : 0) +
        (dBsi >= f * Math.abs(t.vegLossD) ? 1 : 0);
    } else if (
      (dNdvi >= t.vegGainD ? 1 : 0) + (dNdmi >= f * t.vegGainD ? 1 : 0) +
        (dBsi <= -f * t.vegGainD ? 1 : 0) >=
      2
    ) {
      code = CLASS.vegGain;
      votes =
        (dNdvi >= t.vegGainD ? 1 : 0) +
        (dNdmi >= f * t.vegGainD ? 1 : 0) +
        (dBsi <= -f * t.vegGainD ? 1 : 0);
    } else if (
      dNdvi <= t.bareBuiltNdviMax &&
      a.mndwi[i] <= t.bareBuiltMaxMndwi &&
      b.mndwi[i] <= t.bareBuiltMaxMndwi &&
      (dNdbi >= t.bareBuiltD ? 1 : 0) + (dBsi >= f * t.bareBuiltD ? 1 : 0) +
        (dBright >= brightT ? 1 : 0) >=
        2
    ) {
      code = CLASS.bareBuilt;
      votes =
        (dNdbi >= t.bareBuiltD ? 1 : 0) +
        (dBsi >= f * t.bareBuiltD ? 1 : 0) +
        (dBright >= brightT ? 1 : 0);
    }

    if (code === CLASS.noChange) continue;

    // ── persistence: recent-orbit Δ agrees with the composite Δ ───────────
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
    // A-side stability: A's own latest orbit must not deviate from A's median
    // beyond the class threshold — otherwise the "before" state itself is mixed.
    const aStable =
      Math.abs(aRecentVal(code, aRecent, i) - driverVal(a, code, i)) <
      Math.abs(primaryThreshold);
    const persistent =
      signOk &&
      aStable &&
      Math.abs(recentDelta) >= VOTE.persistFactor * Math.abs(primaryThreshold);
    persistGrid[i] = persistent ? PERSIST.yes : PERSIST.transient;
    if (persistent) persistentPixels += 1;
    else transientPixels += 1;

    // ── CVA magnitude in threshold units ──────────────────────────────────
    // Ratios are clamped to ±10: degenerate near-zero denominators on
    // pathological pixels otherwise blow the mean up into the thousands.
    const norm = (d: number, m: number): number => Math.max(-10, Math.min(10, d / m));
    const cva = Math.sqrt(
      norm(dNdvi, mNdvi) ** 2 +
        norm(dMndwi, mMndwi) ** 2 +
        norm(dNdbi, mNdbi) ** 2 +
        norm(dBsi, mBsi) ** 2 +
        norm(dNbr, mNbr) ** 2,
    );

    // ── sub-label (§2.5/2.6) ──────────────────────────────────────────────
    let seasonal = false;
    switch (code) {
      case CLASS.waterGain:
        sub = persistent ? SUB.waterGainNew : SUB.waterGainPonding;
        break;
      case CLASS.waterLoss:
        sub = persistent ? SUB.waterLossReceded : SUB.waterLossDrawdown;
        break;
      case CLASS.vegLoss:
        if (input.seasonalLossTag) {
          sub = SUB.vegLossHarvest;
          seasonal = true;
        } else if (
          dBsi >= f * Math.abs(t.vegLossD) ||
          dBright >= brightT
        ) {
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
      case CLASS.bareBuilt:
        sub = dBright > 0 && dNdvi <= 0 ? SUB.bareBuiltConstruction : SUB.bareBuiltBare;
        break;
    }

    // ── confidence tier (§2.8): scored, every change pixel gets one ───────
    let score = votes === 3 ? 2 : 1;
    if (cva >= VOTE.cvaBoost) score += 1;
    score += persistent ? 1 : -1;
    if (seasonal) score -= 1;
    if (input.shortGap && (code === CLASS.vegLoss || code === CLASS.vegGain)) score -= 1;
    tierGrid[i] =
      score >= VOTE.highScore ? TIER.high : score >= VOTE.mediumScore ? TIER.medium : TIER.low;
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
    cvaMean: changePixels > 0 ? cvaSum / changePixels : 0,
    changePixels,
    persistentPixels,
    transientPixels,
  };
}
