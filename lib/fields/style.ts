/**
 * Fields map style (Phase 2 of the Fields & cropping-pattern demo): pure
 * MapLibre expression builders for colour-by (pattern / group / confidence),
 * class-filter muting, hover/selection/flash emphasis, and the fill/outline
 * render modes.
 *
 * The `match` arms are nested as `[["get", …], …]` — a flattened
 * `["get", "cls"]` spread makes MapLibre read `cls` as the first *label* and
 * then reject the whole paint property (even-arguments warning), which is
 * exactly the root cause that left every parcel solid orange. `classColorExpression`
 * is the single place that builds the arms; scripts/fields-style.test.ts locks
 * the nesting down.
 *
 * Pure: type-only maplibre import (erased at compile), relative imports only,
 * no store, no DOM — the node test harness imports this directly.
 */
import type { ExpressionSpecification } from "maplibre-gl";
import { PATTERN_CLASS_COLORS } from "./colors";
import { PATTERN_CLASSES, type PatternClass } from "./config";

/** What colours the parcel layers. */
export type FieldsColorBy = "pattern" | "group" | "confidence";
/** Fill wash + outline, or outlines only. */
export type FieldsRenderMode = "fill" | "outline";

/**
 * Colour-blind-safe categorical ramp for k-means curve groups (Okabe-Ito
 * order, rotated per group index; wraps past 6 groups). Group ids are
 * arbitrary clusters, so hue carries no meaning — only separation does.
 */
export const GROUP_COLORS = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // bluish green
  "#CC79A7", // reddish purple
  "#56B4E9", // sky blue
  "#D55E00", // vermillion
] as const;

export function groupColor(group: number): string {
  const index = ((group % GROUP_COLORS.length) + GROUP_COLORS.length) % GROUP_COLORS.length;
  return GROUP_COLORS[index];
}

/** Fill opacities (spec band: 15–25 % base wash, stronger on emphasis). */
export const FILL_OPACITY = {
  /** Class-coloured wash over the basemap. */
  base: 0.18,
  /** Boundaries shown without any pattern/confidence data. */
  plain: 0.12,
  flash: 0.5,
  selected: 0.38,
  hover: 0.32,
  /** Deselected by the legend filter — stays visible as a ghost. */
  muted: 0.05,
} as const;

export const FIELDS_LINE = {
  width: 1,
  hoverWidth: 1.75,
  selectedWidth: 2.5,
  flashWidth: 3,
  opacity: 0.9,
  mutedOpacity: 0.25,
} as const;

/**
 * `["match", ["get","cls"], …]` — the input expression is ONE array element;
 * every class/colour pair follows, then the default. Correct nesting is the
 * Phase 2 root-cause fix (see file header).
 */
export function classColorExpression(
  fallback: string = PATTERN_CLASS_COLORS.unclassified,
): ExpressionSpecification {
  const arms: unknown[] = ["match", ["get", "cls"]];
  for (const cls of PATTERN_CLASSES) arms.push(cls, PATTERN_CLASS_COLORS[cls]);
  arms.push(fallback);
  return arms as ExpressionSpecification;
}

/** `["match", ["get","group"], 0, …, default]` over the k cluster ids. */
export function groupColorExpression(groupCount: number): ExpressionSpecification {
  const arms: unknown[] = ["match", ["get", "group"]];
  for (let group = 0; group < groupCount; group++) arms.push(group, groupColor(group));
  arms.push(PATTERN_CLASS_COLORS.unclassified);
  return arms as ExpressionSpecification;
}

/**
 * Confidence ramp: low → high as vermillion → orange → bluish green (all
 * colour-blind safe, monotone in lightness). `coalesce` keeps null-confidence
 * parcels on the low end instead of failing the whole paint property.
 */
export function confidenceColorExpression(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["coalesce", ["get", "confidence"], 0],
    0,
    "#D55E00",
    50,
    "#E69F00",
    100,
    "#009E73",
  ] as ExpressionSpecification;
}

export interface ColorByContext {
  hasPattern: boolean;
  /** `pattern.grouping.k` (0 when grouping is off/unavailable). */
  groupCount: number;
  confidenceAvailable: boolean;
}

/**
 * The colour expression for the active colour-by mode, or null when the data
 * cannot support it (caller keeps the plain boundary colour). Falls back to
 * pattern colours whenever the requested mode has no data behind it.
 */
export function colorByExpression(
  mode: FieldsColorBy,
  context: ColorByContext,
): ExpressionSpecification | null {
  if (mode === "confidence" && context.confidenceAvailable) return confidenceColorExpression();
  if (mode === "group" && context.groupCount > 0) return groupColorExpression(context.groupCount);
  if (context.hasPattern) return classColorExpression();
  return null;
}

/** `["in", ["get","cls"], ["literal", …]]` guard for an active class filter. */
function classFilterGuard(active: readonly PatternClass[] | null): unknown | null {
  if (!active || active.length === 0) return null;
  return ["in", ["get", "cls"], ["literal", [...active]]];
}

export interface FilterOptions {
  active?: readonly PatternClass[] | null;
}

/**
 * Fill opacity: feature-state emphasis (flash > selected > hover) over the
 * base wash, with filter-excluded parcels dropped to a ghost (or kept at base
 * when no filter is active).
 */
export function fieldsFillOpacityExpression(
  options: { base: number } & FilterOptions,
): ExpressionSpecification {
  const guard = classFilterGuard(options.active ?? null);
  const base: unknown = guard
    ? ["case", guard, options.base, FILL_OPACITY.muted]
    : options.base;
  return [
    "case",
    ["boolean", ["feature-state", "flash"], false],
    FILL_OPACITY.flash,
    ["boolean", ["feature-state", "selected"], false],
    FILL_OPACITY.selected,
    ["boolean", ["feature-state", "hover"], false],
    FILL_OPACITY.hover,
    base,
  ] as ExpressionSpecification;
}

/** Outline width: flash > selected > hover > base (1 px). */
export function fieldsLineWidthExpression(): ExpressionSpecification {
  return [
    "case",
    ["boolean", ["feature-state", "flash"], false],
    FIELDS_LINE.flashWidth,
    ["boolean", ["feature-state", "selected"], false],
    FIELDS_LINE.selectedWidth,
    ["boolean", ["feature-state", "hover"], false],
    FIELDS_LINE.hoverWidth,
    FIELDS_LINE.width,
  ] as ExpressionSpecification;
}

/** Outline opacity: emphasis pins to 1, filtered-out parcels fade to a ghost. */
export function fieldsLineOpacityExpression(options: FilterOptions): ExpressionSpecification {
  const guard = classFilterGuard(options.active ?? null);
  const base: unknown = guard
    ? ["case", guard, FIELDS_LINE.opacity, FIELDS_LINE.mutedOpacity]
    : FIELDS_LINE.opacity;
  return [
    "case",
    ["boolean", ["feature-state", "flash"], false],
    1,
    ["boolean", ["feature-state", "selected"], false],
    1,
    ["boolean", ["feature-state", "hover"], false],
    1,
    base,
  ] as ExpressionSpecification;
}

/** Fill layer visibility: hidden entirely in outline-only render mode. */
export function fillLayerVisibility(
  layersVisible: boolean,
  mode: FieldsRenderMode,
): "visible" | "none" {
  return layersVisible && mode === "fill" ? "visible" : "none";
}
