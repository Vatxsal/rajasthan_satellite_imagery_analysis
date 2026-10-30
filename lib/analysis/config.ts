/**
 * Change-detection configuration: classification thresholds, sensitivity
 * scaling, noise control and the class palette.
 *
 * ── Sources / rationale (ALL thresholds are tunable defaults) ──────────────
 * The method is two-date spectral index differencing, the standard lightweight
 * alternative to full BDA/bitemporal classifiers:
 *
 *  - ΔNDVI = NDVI(B) − NDVI(A) is the core signal of the International
 *    Charter on Space and Major Disasters "NDVI change detection (NDVI-CD)"
 *    recipe and of Sentinel Hub's published NDVI-difference evalscript
 *    (custom-scripts.sentinel-hub.com/sentinel-2/ndvi_diff). Vegetation
 *    changes of |ΔNDVI| ≥ 0.15 are widely treated as meaningful for
 *    parcel/canopy scale work; 0.15 sits above typical seasonal noise for a
 *    same-season pair while still catching crop harvest/cut and browning.
 *  - ΔMNDWI (MNDWI = (G−SWIR)/(G+SWIR), Xu 2006) reacts to surface water;
 *    ±0.20 is a conservative differencing band around the classic
 *    MNDWI ≈ 0 water/land split, so open-water gain/loss is picked up
 *    without flickering at the shoreline.
 *  - ΔNDBI ((SWIR−NIR)/(SWIR+NIR), Zha 2003) rises when bare soil/built-up
 *    replaces vegetation; +0.10 combined with a simultaneous ΔNDVI ≤ −0.05
 *    separates construction/bare from greening/irrigation signals.
 *
 * These are heuristics, not physics: Rajasthan's irrigated cropland, kharif
 * crop cycles and harvest timing all move the indices. Keep them in ONE file
 * (this one) so they can be tuned and are always echoed back in the analysis
 * metadata.
 */

/** Ordered classification classes. Precedence = the order in CLASS_ORDER. */
export type Sensitivity = "low" | "medium" | "high";

/**
 * Low = conservative (fewer, stronger changes) → thresholds × 1.5.
 * Medium = × 1. High = sensitive (more changes) → × 0.7.
 */
export const SENSITIVITY_MULTIPLIER: Record<Sensitivity, number> = {
  low: 1.5,
  medium: 1,
  high: 0.7,
};

export const DEFAULT_SENSITIVITY: Sensitivity = "medium";
/** Long-side cap of the analysis grid (px) — server override COMPARE_MAX_PX. */
export const DEFAULT_MAX_PX = 1500;
/** Minimum mapping unit in hectares — patches smaller than this become "no change". */
export const DEFAULT_MIN_PATCH_HA = 0.2;
/** 3×3 majority (mode) filter kernel size. */
export const MAJORITY_WINDOW = 3;

export const THRESHOLDS = {
  /** ΔMNDWI ≥ +0.20 and MNDWI(B) > 0 → open water appeared. */
  waterGain: { dMndwi: 0.2, mndwiAfter: 0 },
  /** ΔMNDWI ≤ −0.20 and MNDWI(A) > 0 → open water disappeared. */
  waterLoss: { dMndwi: -0.2, mndwiBefore: 0 },
  /** ΔNDVI ≤ −0.15 → vegetation loss. */
  vegLoss: { dNdvi: -0.15 },
  /** ΔNDVI ≥ +0.15 → vegetation gain. */
  vegGain: { dNdvi: 0.15 },
  /** ΔNDBI ≥ +0.10 with ΔNDVI ≤ −0.05, and neither date is open water. */
  bareBuilt: { dNdbi: 0.1, dNdviMax: -0.05, maxMndwi: 0.1 },
} as const;

export interface ScaledThresholds {
  waterGainD: number;
  waterLossD: number;
  vegLossD: number;
  vegGainD: number;
  bareBuiltD: number;
  bareBuiltNdviMax: number;
  bareBuiltMaxMndwi: number;
  /** After-state gate: MNDWI(B) must exceed this (became open water; config 0). */
  waterGainMndwiMin: number;
  /** Before-state gate: MNDWI(A) must exceed this (was open water; config 0). */
  waterLossMndwiMin: number;
}

/** Applies the sensitivity multiplier to every threshold. */
export function scaledThresholds(sensitivity: Sensitivity): ScaledThresholds {
  const m = SENSITIVITY_MULTIPLIER[sensitivity];
  return {
    waterGainD: THRESHOLDS.waterGain.dMndwi * m,
    waterLossD: THRESHOLDS.waterLoss.dMndwi * m,
    vegLossD: THRESHOLDS.vegLoss.dNdvi * m,
    vegGainD: THRESHOLDS.vegGain.dNdvi * m,
    bareBuiltD: THRESHOLDS.bareBuilt.dNdbi * m,
    bareBuiltNdviMax: THRESHOLDS.bareBuilt.dNdviMax * m,
    bareBuiltMaxMndwi: THRESHOLDS.bareBuilt.maxMndwi * m,
    waterGainMndwiMin: THRESHOLDS.waterGain.mndwiAfter,
    waterLossMndwiMin: THRESHOLDS.waterLoss.mndwiBefore,
  };
}

/** Class codes stored in the classified raster (uint8). */
export const CLASS = {
  noChange: 0,
  vegGain: 1,
  vegLoss: 2,
  bareBuilt: 3,
  waterGain: 4,
  waterLoss: 5,
  masked: 6,
  /** Outside the selected polygon — transparent, never counted. */
  outside: 255,
} as const;

export interface ClassDef {
  code: number;
  label: string;
  /** [r, g, b] 0-255 — color-blind safe assignment (gain green, loss orange/red, ...). */
  color: [number, number, number];
  /** True for actual change classes (excludes no-change / masked / outside). */
  change: boolean;
}

/** Legend order = classification precedence order. */
export const CLASS_DEFS: readonly ClassDef[] = [
  { code: CLASS.waterGain, label: "Water gain", color: [56, 132, 255], change: true },
  { code: CLASS.waterLoss, label: "Water loss", color: [226, 183, 45], change: true },
  { code: CLASS.vegLoss, label: "Vegetation loss", color: [227, 99, 44], change: true },
  { code: CLASS.vegGain, label: "Vegetation gain", color: [45, 164, 78], change: true },
  { code: CLASS.bareBuilt, label: "Bare / built-up increase", color: [170, 70, 190], change: true },
  { code: CLASS.noChange, label: "No change", color: [0, 0, 0], change: false },
  { code: CLASS.masked, label: "Masked (clouds / no data)", color: [165, 165, 165], change: false },
];

export const CLASS_BY_CODE: Record<number, ClassDef> = Object.fromEntries(
  CLASS_DEFS.map((def) => [def.code, def]),
);

export function classLabel(code: number): string {
  return CLASS_BY_CODE[code]?.label ?? "No change";
}

export function classColor(code: number): [number, number, number] {
  return CLASS_BY_CODE[code]?.color ?? [0, 0, 0];
}

/** Classification precedence — evaluated top to bottom for every pixel. */
export const CLASS_ORDER = [
  CLASS.waterGain,
  CLASS.waterLoss,
  CLASS.vegLoss,
  CLASS.vegGain,
  CLASS.bareBuilt,
] as const;

/** 1 ha = 10 000 m². */
export const M2_PER_HA = 10_000;

/** Sentinel SCL classes excluded from VALID: no-data, saturated/defective,
 *  cloud shadow, medium cloud, high cloud, thin cirrus, snow. */
export const EXCLUDED_SCL = [0, 1, 3, 8, 9, 10, 11] as const;

/** Engine-v2 composite: ±days around each date (0 = single day, v1-equivalent).
 *  S2A+S2B revisit ≈ 5 d, so ±7 d → typically ~3 orbits per side (see audit §5). */
export const COMPOSITE_WINDOW_DAYS_DEFAULT = 7;
export const COMPOSITE_WINDOW_DAYS_MAX = 15;
/** Composite sample gate: max per-pixel cloud probability (%, Sen2Cor CLD band). */
export const COMPOSITE_MAX_CLOUD_PROB = 30;
/** Composite valid-mask erosion radius (px) — twice v1's 1 px halo (cloud edges). */
export const COMPOSITE_ERODE_RADIUS = 2;

// ── Engine v2 ──────────────────────────────────────────────────────────────

/** Sub-labels (v2): finer description attached to a change class. Codes are
 *  offset from the class code (class × 10 + variant) and stay within uint8. */
export const SUB = {
  vegLossCleared: 20,
  vegLossHarvest: 21,
  vegLossStress: 22,
  vegGainSeasonal: 11,
  vegGainRecovery: 12,
  waterGainNew: 40,
  waterGainPonding: 41,
  waterLossReceded: 50,
  waterLossDrawdown: 51,
  bareBuiltConstruction: 30,
  bareBuiltBare: 31,
} as const;

export type SubCode = (typeof SUB)[keyof typeof SUB];

const SUB_LABELS: Record<number, string> = {
  [SUB.vegLossCleared]: "Vegetation cleared / land exposed",
  [SUB.vegLossHarvest]: "Likely harvest / crop cycle",
  [SUB.vegLossStress]: "Vegetation browning / stress",
  [SUB.vegGainSeasonal]: "Seasonal greening / crop growth",
  [SUB.vegGainRecovery]: "Vegetation recovery",
  [SUB.waterGainNew]: "New open water",
  [SUB.waterGainPonding]: "Temporary ponding",
  [SUB.waterLossReceded]: "Water body receded",
  [SUB.waterLossDrawdown]: "Water drawdown",
  [SUB.bareBuiltConstruction]: "Built-up / construction signal",
  [SUB.bareBuiltBare]: "Bare soil increase",
};

export function subLabel(subCode: number): string | null {
  return SUB_LABELS[subCode] ?? null;
}

/** Seasonal (crop-cycle) windows as MM-DD ranges, Rajasthan kharif/rabi
 *  calendar. A change inside a matching window is tagged and loses one
 *  confidence step — vegetation change in harvest season is expected phenology,
 *  not necessarily real land-cover change. Tunable heuristics, not physics. */
export const SEASONAL_WINDOWS = [
  { tag: "kharif-harvest", from: "10-01", to: "11-15", kind: "loss" },
  { tag: "rabi-harvest", from: "03-15", to: "04-30", kind: "loss" },
  { tag: "monsoon-greening", from: "06-15", to: "09-15", kind: "gain" },
] as const;

export type SeasonalTag = (typeof SEASONAL_WINDOWS)[number]["tag"];

/** Seasonal tag for `date` when a class of `kind` ("loss" | "gain") changes. */
export function seasonalTag(
  date: string,
  kind: "loss" | "gain",
): SeasonalTag | null {
  const mmdd = date.slice(5);
  for (const w of SEASONAL_WINDOWS) {
    if (w.kind !== kind) continue;
    if (mmdd >= w.from && mmdd <= w.to) return w.tag;
  }
  return null;
}

/** Robust σ reference per Δ-index for the adaptive threshold scale
 *  (scale = clamp(σ/ref, MIN..MAX); refs ≈ typical seasonal noise, audit §8.5). */
export const V2_REFERENCE_SIGMA: Record<string, number> = {
  ndvi: 0.08,
  mndwi: 0.08,
  ndbi: 0.05,
  bsi: 0.06,
};
export const ADAPTIVE_SCALE_MIN = 0.7;
export const ADAPTIVE_SCALE_MAX = 1.5;
/** Gap below this (days) → vegetation classes lose one confidence step (§2.6). */
export const V2_SHORT_GAP_DAYS = 14;

/** Multi-index voting + confidence scoring constants (v2, §2.5/§2.8). */
export const VOTE = {
  /** Corroborating index must cross this × the primary adaptive Δ threshold. */
  corrobFactor: 0.6,
  /** |ΔAWEI| corroboration for water classes (× the MNDWI adaptive scale). */
  aweiCorrob: 0.08,
  /** Δbrightness corroboration for bare/built (× the NDBI adaptive scale). */
  brightCorrob: 0.03,
  /** CVA magnitude (in threshold units) that adds one confidence point. */
  cvaBoost: 2.5,
  /** Score ≥ highScore → high; ≥ mediumScore → medium; else low. */
  highScore: 4,
  mediumScore: 2,
  /** Recent-orbit Δ must reach this fraction of the threshold to be persistent. */
  persistFactor: 0.5,
} as const;

// ── Phase 3 — denoise & vector output ──────────────────────────────────────

/** Confidence-aware MMU (v2): keep patches ≥ this × MMU when their pixels are
 *  mostly high-confidence — fixes the hard MMU erasure of real small changes. */
export const MMU_CONFIDENCE_SIZE_FACTOR = 0.5;
export const MMU_CONFIDENCE_HIGH_SHARE = 0.4;

/** Patch outlines: Douglas-Peucker tolerance (edge/pixel units) before
 *  corner-cutting — 0.5 px collapses stair-steps into diagonals. */
export const POLYGON_SIMPLIFY_PX = 0.5;
/** Chaikin corner-cutting passes after simplification (visual smoothing only —
 *  stats/areas always come from the raster, never from these vertices). */
export const POLYGON_SMOOTH_PASSES = 2;
