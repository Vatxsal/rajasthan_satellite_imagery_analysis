import { PATTERN_CLASSES, type PatternClass } from "./config";

/**
 * Phase 3 UI presentation: class labels and stable map/UI colours.
 * Distinct hues so a choropleth is readable on both light and satellite
 * basemaps; `unclassified` stays neutral so missing data never reads as a
 * real cropping pattern.
 */
export const PATTERN_CLASS_LABELS: Record<PatternClass, string> = {
  fallow: "Fallow",
  "kharif-only": "Kharif only",
  "rabi-only": "Rabi only",
  "double-cropped": "Double-cropped",
  zaid: "Zaid",
  evergreen: "Evergreen",
  unclassified: "Unclassified",
};

/**
 * Hex colours aligned with the Okabe-Ito colour-blind-safe palette (one hue
 * per class, pairwise distinguishable under deuteranopia/protanopia; legible
 * on light and satellite basemaps). The same record colours the map fill, the
 * legend chips, the field list and the small multiples — one source of truth
 * so map and legend can never drift. `fallow` and `unclassified` differ in
 * lightness (dark stone vs light grey) so the safety fallback never reads as
 * a real cropping pattern.
 */
export const PATTERN_CLASS_COLORS: Record<PatternClass, string> = {
  fallow: "#D55E00", // vermillion — bare / nothing grew
  "kharif-only": "#009E73", // bluish green — monsoon crop
  "rabi-only": "#0072B2", // blue — winter crop
  "double-cropped": "#CC79A7", // reddish purple — two cycles
  zaid: "#E69F00", // orange — summer crop
  evergreen: "#56B4E9", // sky blue — green year-round
  unclassified: "#9CA3AF", // neutral grey — rules could not place it
};

/** Neutral outline when boundaries are shown without a pattern result. */
export const FIELDS_BOUNDARY_COLOR = "#C2410C";

export function patternClassLabel(cls: string): string {
  return (PATTERN_CLASS_LABELS as Record<string, string>)[cls] ?? cls;
}

export function patternClassColor(cls: string): string {
  return (PATTERN_CLASS_COLORS as Record<string, string>)[cls] ?? PATTERN_CLASS_COLORS.unclassified;
}

/** Classes with a non-zero count, in declaration order (legend rows). */
export function presentPatternClasses(
  counts: Partial<Record<PatternClass, number>>,
): Array<{ cls: PatternClass; count: number }> {
  return PATTERN_CLASSES.filter((cls) => (counts[cls] ?? 0) > 0).map((cls) => ({
    cls,
    count: counts[cls] ?? 0,
  }));
}
