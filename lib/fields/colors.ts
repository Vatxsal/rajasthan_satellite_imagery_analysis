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

/** Hex colours aligned with Tailwind-ish ramps (legible on light + dark). */
export const PATTERN_CLASS_COLORS: Record<PatternClass, string> = {
  fallow: "#A8A29E",
  "kharif-only": "#16A34A",
  "rabi-only": "#2563EB",
  "double-cropped": "#9333EA",
  zaid: "#D97706",
  evergreen: "#0F766E",
  unclassified: "#9CA3AF",
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
