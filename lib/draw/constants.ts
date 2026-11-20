/**
 * Draw & analyze — client-side shape limits and palette. The server re-checks
 * the same numbers in POST /api/shapes/validate (env overrides DRAW_MAX_*
 * land in a later phase); the client copies keep live HUD feedback honest but
 * never authoritative — every rule is re-checked server-side before analysis.
 */

/** Maximum polygon area in square kilometres. */
export const DRAW_MAX_KM2 = 100;

/** Maximum longest-side of the shape's bounding box, in kilometres. */
export const DRAW_MAX_BBOX_KM = 25;

/** Maximum vertex count (exterior-ring positions, closing point excluded). */
export const DRAW_MAX_VERTICES = 500;

/** Circle ring resolution — matches the server-side tessellation. */
export const CIRCLE_SEGMENTS = 64;

/** Minimum share of the shape that must fall inside Rajasthan. */
export const RAJASTHAN_MIN_INSIDE_PCT = 95;

/** Long-side cap (px) of the analysis render behind POST /api/shapes/analyze. */
export const ANALYZE_MAX_PX = 512;

/** Input bands of the analysis evalscript counted by the PU formula (dataMask excluded). */
export const ANALYSIS_INPUT_BANDS = 7;

/** Rajasthan outline used for the live inside-check (client-fetched once). */
export const RAJASTHAN_OUTLINE_URL = "/data/state-outline.geojson";

export type DrawTool = "polygon" | "rectangle" | "circle" | "select";

/** Shape colours cycled in draw order; the card can override per shape. */
export const DRAW_PALETTE = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed"] as const;

export const DRAW_DEFAULT_COLOR: string = DRAW_PALETTE[0];

/** Tool → friendly HUD label. */
export const DRAW_TOOL_LABELS: Record<Exclude<DrawTool, "select">, string> = {
  polygon: "Polygon",
  rectangle: "Rectangle",
  circle: "Circle",
};
