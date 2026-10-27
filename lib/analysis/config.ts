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
