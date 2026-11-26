/**
 * Phase 4 — the change probe: pure verdict logic for a native-resolution
 * window around one point. Answers "why is this spot changed / unchanged?"
 * with the applied thresholds and the MMU, so a miss is explainable:
 *
 *   kept          — the pixel's patch survived the full pipeline
 *   below-mmu     — classified change, but the component is smaller than the
 *                   minimum patch size (the MMU cut it — lower it to catch)
 *   sub-threshold — deltas below the applied thresholds (near misses report
 *                   at ≥ 0.5× a threshold; suggest higher sensitivity)
 *   no-change     — deltas ≈ 0
 *   masked        — cloud / no data on one of the dates
 *
 * Pure typed-array logic — the fetch orchestration lives in
 * lib/server/probeRun, tests exercise exactly what the route answers.
 */
import { CLASS, classLabel, MAGNITUDE_SCALE } from "./config";

export type ProbeVerdict = "kept" | "below-mmu" | "sub-threshold" | "no-change" | "masked";

export interface ProbeInput {
  /** Window class grid (CLASS codes). */
  classGrid: Uint8Array;
  /** Kept-patch labels (0 = no kept patch — the MMU may have cut it). */
  labels: Int32Array;
  /** Confidence tiers (1 low / 2 medium / 3 high); null for v1 pre-Phase-2. */
  tiers: Uint8Array | null;
  /** COVERAGE_REASON raster of the window. */
  coverage: Uint8Array;
  magnitude: { ndvi: Int8Array; mndwi: Int8Array; ndbi: Int8Array };
  /** Applied thresholds (metadata.thresholds). */
  thresholds: Record<string, number>;
  width: number;
  height: number;
  /** Pixel area in ha of the window grid. */
  pxAreaHa: number;
  /** The MMU the labels were cut at. */
  minPatchHa: number;
  /** Center pixel (the probed point). */
  centerIdx: number;
}

export interface ProbeResult {
  verdict: ProbeVerdict;
  classCode: number | null;
  classLabel: string | null;
  /** Patch size measured inside the window (ha; null when no patch). */
  patchHa: number | null;
  /** The patch touches the window edge — the true patch is larger. */
  clipped: boolean;
  confidence: "low" | "medium" | "high" | null;
  /** Δ-index values at the probed pixel (index units). */
  deltas: { ndvi: number; mndwi: number; ndbi: number };
  /** Applied thresholds (for the client's explain line). */
  thresholds: Record<string, number>;
  minPatchHa: number;
  /** Masked verdict: which date / reason. */
  coverage: "a-missing" | "b-missing" | "cloud" | "unknown" | null;
}

/** Representative per-index threshold (same rule as the classifier). */
function indexThreshold(thresholds: Record<string, number>, index: "ndvi" | "mndwi" | "ndbi"): number {
  if (index === "ndvi") {
    return Math.max(Math.abs(thresholds.vegLossDNdvi ?? 0), Math.abs(thresholds.vegGainDNdvi ?? 0));
  }
  if (index === "mndwi") {
    return Math.max(Math.abs(thresholds.waterLossDMndwi ?? 0), Math.abs(thresholds.waterGainDMndwi ?? 0));
  }
  return Math.abs(thresholds.bareBuiltDNdbi ?? 0);
}

/** Flood-fills the 4-connected same-class component around the seed. */
function floodSameClass(
  classGrid: Uint8Array,
  width: number,
  height: number,
  seed: number,
): { count: number; clipped: boolean } {
  const code = classGrid[seed];
  const seen = new Uint8Array(classGrid.length);
  const stack: number[] = [seed];
  seen[seed] = 1;
  let count = 0;
  let clipped = false;
  while (stack.length > 0) {
    const idx = stack.pop()!;
    count += 1;
    const col = idx % width;
    const row = (idx - col) / width;
    if (col === 0 || col === width - 1 || row === 0 || row === height - 1) clipped = true;
    if (col > 0 && !seen[idx - 1] && classGrid[idx - 1] === code) {
      seen[idx - 1] = 1;
      stack.push(idx - 1);
    }
    if (col < width - 1 && !seen[idx + 1] && classGrid[idx + 1] === code) {
      seen[idx + 1] = 1;
      stack.push(idx + 1);
    }
    if (row > 0 && !seen[idx - width] && classGrid[idx - width] === code) {
      seen[idx - width] = 1;
      stack.push(idx - width);
    }
    if (row < height - 1 && !seen[idx + width] && classGrid[idx + width] === code) {
      seen[idx + width] = 1;
      stack.push(idx + width);
    }
  }
  return { count, clipped };
}

/** Counts the kept patch (one label) inside the window. */
function countLabel(labels: Int32Array, label: number, width: number, height: number): {
  count: number;
  clipped: boolean;
} {
  let count = 0;
  let clipped = false;
  for (let idx = 0; idx < labels.length; idx++) {
    if (labels[idx] !== label) continue;
    count += 1;
    const col = idx % width;
    const row = (idx - col) / width;
    if (col === 0 || col === width - 1 || row === 0 || row === height - 1) clipped = true;
  }
  return { count, clipped };
}

function tierText(tier: number | undefined): "low" | "medium" | "high" | null {
  if (tier === 3) return "high";
  if (tier === 2) return "medium";
  if (tier === 1) return "low";
  return null;
}

/** A delta counts as a near miss at ≥ this share of its applied threshold. */
export const PROBE_NEAR_MISS_SHARE = 0.5;

export function interpretProbe(input: ProbeInput): ProbeResult {
  const { classGrid, labels, tiers, coverage, magnitude, thresholds } = input;
  const i = input.centerIdx;
  const deltas = {
    ndvi: magnitude.ndvi[i] / MAGNITUDE_SCALE,
    mndwi: magnitude.mndwi[i] / MAGNITUDE_SCALE,
    ndbi: magnitude.ndbi[i] / MAGNITUDE_SCALE,
  };
  const base = {
    deltas,
    thresholds,
    minPatchHa: input.minPatchHa,
    coverage: null,
  };

  const code = classGrid[i];
  if (code === CLASS.masked) {
    const reason = coverage[i];
    return {
      ...base,
      verdict: "masked",
      classCode: code,
      classLabel: classLabel(code),
      patchHa: null,
      clipped: false,
      confidence: null,
      coverage:
        reason === 1
          ? "a-missing"
          : reason === 2
            ? "b-missing"
            : reason === 3
              ? "cloud"
              : "unknown",
    };
  }

  if (code === CLASS.noChange || !(code >= CLASS.vegGain && code <= CLASS.waterLoss)) {
    // Explain the miss: near when any |Δ| reaches ≥ half its threshold.
    const ratios = [
      Math.abs(deltas.ndvi) / (indexThreshold(thresholds, "ndvi") || 1),
      Math.abs(deltas.mndwi) / (indexThreshold(thresholds, "mndwi") || 1),
      Math.abs(deltas.ndbi) / (indexThreshold(thresholds, "ndbi") || 1),
    ];
    const near = Math.max(...ratios) >= PROBE_NEAR_MISS_SHARE;
    return {
      ...base,
      verdict: near ? "sub-threshold" : "no-change",
      classCode: null,
      classLabel: null,
      patchHa: null,
      clipped: false,
      confidence: null,
    };
  }

  // Change class at the probed pixel.
  const classFields = {
    classCode: code,
    classLabel: classLabel(code),
    confidence: tierText(tiers?.[i]),
  };
  const label = labels[i];
  if (label > 0) {
    const { count, clipped } = countLabel(labels, label, input.width, input.height);
    return {
      ...base,
      verdict: "kept",
      ...classFields,
      patchHa: Math.round(count * input.pxAreaHa * 100) / 100,
      clipped,
      coverage: null,
    };
  }
  // Classified change, no kept patch → the MMU cut it.
  const { count, clipped } = floodSameClass(classGrid, input.width, input.height, i);
  return {
    ...base,
    verdict: "below-mmu",
    ...classFields,
    patchHa: Math.round(count * input.pxAreaHa * 100) / 100,
    clipped,
    coverage: null,
  };
}
