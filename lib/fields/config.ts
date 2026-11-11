/**
 * Tunables for the Fields & cropping pattern demo (Phase 1: boundary
 * extraction; Phase 2: monthly-NDVI pattern classification).
 */

/** PMTiles zoom that fetches fields — 13 ≈ 1.2 m precision for IN_RJ. */
export const FIELDS_TILE_ZOOM = 13;
/** Hard cap on z13 tiles per request (a backstop behind FIELDS_MAX_KM2). */
export const FIELDS_MAX_TILES = 16;
/** Below this area a field is flagged `tiny` (sliver / digitising artefact). */
export const FIELDS_TINY_M2 = 500;
/** Above this area a field is flagged `huge` (industrial plot / mis-detect). */
export const FIELDS_HUGE_M2 = 200_000;
/**
 * Degrees around a tile edge within which cross-tile duplicates are tested.
 * tippecanoe pads tiles by ~5 % of the tile width (~220 m ≈ 0.002° here), so
 * genuine twins always fall inside this strip.
 */
export const FIELDS_EDGE_EPS_DEG = 0.003;
/** Intersection/min-area ratio above which two edge copies are the same field. */
export const FIELDS_MERGE_MIN_OVERLAP = 0.5;
/** Absolute ceiling of features built per entry (defence against dense areas). */
export const FIELDS_BUILD_CAP = 12_000;

/** Attribution shown with fields data (Phase 3 UI, also in README/PR). */
export const FIELDS_ATTRIBUTION_VECTORS =
  "Field boundaries © Fields of the World (Taylor Geospatial Institute et al. " +
  "with Microsoft AI for Good, ASU, Washington University, OSU and Clark University), " +
  "CC BY 4.0 — Robinson et al. 2026, arXiv:2605.11055, via Source Cooperative.";

export const FIELDS_ATTRIBUTION_CONFIDENCE =
  "Field confidence derived from PRUE model predictions (arXiv:2603.27101) " +
  "of Fields of the World (CC BY 4.0), via Source Cooperative.";

// ── Phase 2 — monthly-NDVI cropping-pattern classification ──────────────────

/**
 * Pattern classes. Never names a crop species — the rules only read the
 * seasonal shape of a 12-month NDVI curve, so `unclassified` is the safety
 * fallback for every series the rules cannot place.
 */
export type PatternClass =
  | "fallow"
  | "kharif-only"
  | "rabi-only"
  | "double-cropped"
  | "zaid"
  | "evergreen"
  | "unclassified";

/** Ordered so a result always lists every class, 0-filled. */
export const PATTERN_CLASSES: readonly PatternClass[] = [
  "fallow",
  "kharif-only",
  "rabi-only",
  "double-cropped",
  "zaid",
  "evergreen",
  "unclassified",
];

/** Peak NDVI below this → nothing grew (fallow / bare / built-up). */
export const PATTERN_GREEN_MIN = 0.25;
/** Minimum NDVI across every month at/above which the field stays green
 *  year-round (evergreen tree cover / dense scrub — not a crop cycle). */
export const PATTERN_EVERGREEN_MIN = 0.4;
/** A double-crop needs a dip of at least this far between two green peaks. */
export const PATTERN_DOUBLE_CROP_DIP = 0.15;
/** Fewer valid months than this → unclassified (no reliable curve). */
export const PATTERN_MIN_VALID_MONTHS = 3;
/** Months in one agri-year curve (Jun … May). */
export const PATTERN_MONTH_COUNT = 12;
/** Centred 3-month moving average applied before the two-peak test. */
export const PATTERN_SMOOTH_WINDOW = 3;
/** ORBIT samples counted per month render in the PU estimate (S2 ≈ 5 d
 *  revisit → ~6 overpasses per month). */
export const PATTERN_MONTH_SAMPLES = 6;
/** Long-side cap (px) of the pattern grid — bounds a long thin bbox so the
 *  12 renders stay well under PER_ANALYSIS_PU_LIMIT (25 km² ≈ 183 PU). */
export const PATTERN_MAX_PX = 1024;
/** k-means: candidate cluster counts, Lloyd iterations, silhouette sample
 *  stride cap, and the minimum field count before grouping is attempted. */
export const PATTERN_GROUPING_K = [3, 4, 5, 6] as const;
export const PATTERN_GROUPING_ITERS = 50;
export const PATTERN_GROUPING_SAMPLE = 300;
export const PATTERN_GROUPING_MIN_FIELDS = 12;
/** Concurrency of the 12 monthly raster fetches (route batches; runPattern
 *  awaits in batches of this size). */
export const PATTERN_FETCH_BATCH = 4;

/**
 * Agri-year season windows as indices into the 12-month series
 * (0 = Jun of `year` … 11 = May of `year + 1`). Rajasthan calendar:
 * kharif = Jun–Sep (monsoon), rabi = Oct–Mar (winter), zaid = Apr–May.
 */
export const PATTERN_SEASONS = {
  kharif: [0, 1, 2, 3],
  rabi: [4, 5, 6, 7, 8, 9],
  zaid: [10, 11],
} as const;

/** Months of the agri year whose peak marks a zaid (summer) crop. */
export const PATTERN_ZAID_PEAK_MONTHS = [10, 11] as const;
