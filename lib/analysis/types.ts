import type { Sensitivity } from "./config";

/** Analysis grid: linear mapping of the request bbox onto width × height pixels
 *  (the Process API renders the EPSG:4326 bbox linearly, so pixel centres are
 *  exact linear interpolations — no reprojection maths needed). */
export interface AnalysisGrid {
  width: number;
  height: number;
  /** [west, south, east, north] in EPSG:4326. */
  bbox: [number, number, number, number];
  /** Degrees per pixel. */
  pxLon: number;
  pxLat: number;
  /** Ground resolution per pixel axis (metres, latitude-corrected). */
  metersX: number;
  metersY: number;
  /** Worst-case resolution (max of both axes) used for the "coarse" notice. */
  metersPerPixel: number;
}

export interface IndexRasters {
  ndvi: Float32Array;
  mndwi: Float32Array;
  ndbi: Float32Array;
}

export interface DateSceneMeta {
  date: string;
  cloudCover: number;
  satellite: string;
  tileCount: number;
}

export interface ClassStat {
  code: number;
  label: string;
  /** [r, g, b] */
  color: [number, number, number];
  pixels: number;
  areaHa: number;
  areaKm2: number;
  /** Percent of the VALID area (denominator excludes masked pixels). */
  pctOfValid: number;
}

export interface TehsilZonalStat {
  tehsilId: string;
  name: string;
  /** Pixels per class code (change classes only; 0-5 keys). */
  pixelsByClass: Record<number, number>;
  /** Area (ha) of all change classes combined in this tehsil. */
  changedHa: number;
  /** Pixels valid inside this tehsil (for the valid-data column). */
  validPixels: number;
  insidePixels: number;
}

/** v2 confidence tier of a change patch (v1 results carry no tier). */
export type ConfidenceTier = "high" | "medium" | "low";

export interface Hotspot {
  /** [lon, lat] centroid in EPSG:4326. */
  centroid: [number, number];
  /** Patch bbox [west, south, east, north]. */
  bbox: [number, number, number, number];
  areaHa: number;
  classCode: number;
  classLabel: string;
  tehsilName: string | null;
  /** Patch outline in EPSG:4326 (map layer + GeoJSON export); null if untraceable. */
  polygon: GeoJSON.MultiPolygon | null;
  /** v2 only: majority confidence tier of the patch pixels. */
  confidence?: ConfidenceTier;
  /** Phase 3 fused only: patch-mean confidence 0-100 (tier is derived from it). */
  confidencePct?: number;
  /** v2 only: majority sub-label text (e.g. "Likely harvest / crop cycle"). */
  subLabel?: string | null;
  /** v2 only: patch tags — "transient" | "crop-cycle" | "short-gap". */
  tags?: string[];
}

/** v2 engine diagnostics echoed into the result metadata. */
export interface EngineStats {
  /** Additive median matching of A onto B (Phase 2.1). */
  normalization: { appliedBands: number; skippedBands: number; maxShift: number };
  /** Integer co-registration search (Phase 2.2). */
  coReg: { dx: number; dy: number; score: number; zeroScore: number; applied: boolean };
  /** Adaptive threshold scale/σ per Δ-index (Phase 2.4). */
  adaptive: { scales: Record<string, number>; sigma: Record<string, number> };
  /** Recent-orbit agreement rate over change pixels (Phase 2.7). */
  persistence: { checked: boolean; persistentPct: number | null };
  /** Seasonal window of dateB, if any (Phase 2.6). */
  cropCycle: { tag: string | null };
  /** Mean CVA magnitude over change pixels (Phase 2.5). */
  cvaMean: number;
  /** SHARPEN_SWIR: per-side B11/B12 fit diagnostics (absent when off). */
  sharpen?: {
    a: { b11: { r2: number; applied: boolean }; b12: { r2: number; applied: boolean } };
    b: { b11: { r2: number; applied: boolean }; b12: { r2: number; applied: boolean } };
  };
}

/** Which engine produced the result (v1 = classic single-date, v2 = composite inputs). */
export type CompareEngine = "v1" | "v2";
/** Input mode actually used: v1 always "single"; v2 defaults to "composite". */
export type CompareInputMode = "single" | "composite";
/** Change-rule mode that produced the result (CHANGE_RULES; legacy = shipped rules). */
export type CompareRulesMode = "legacy" | "fused" | "ml";

/** Which optional evidence the fused rules actually had (method card, Phase 5). */
export interface EvidenceMeta {
  /** S1 outcome: orbit used, or the skip reason (never mixed orbits). */
  s1: { orbit: string } | { skipped: string } | null;
  /** ±days window of the S1 temporal median when SAR was used. */
  s1WindowDays: number | null;
  /** ESA WorldCover 2021 prior was read for this run. */
  worldCover: boolean;
  /** Copernicus DEM terrain (slope/hillshade/shadow) was computed. */
  terrain: boolean;
  /** DEM instance actually rendered (COPERNICUS_30 or _90); null when off. */
  demInstance: string | null;
}

export interface CompareMetadata {
  areaName: string;
  areaLevel: "district" | "tehsil" | "ilr";
  /** Stable area id (same as the analyze request's areaId) — lets every cache-backed
   *  route re-derive the analysis key and recompute statelessly after a cache miss. */
  areaId: string;
  dateA: string;
  dateB: string;
  gapDays: number;
  sceneA: DateSceneMeta | null;
  sceneB: DateSceneMeta | null;
  width: number;
  height: number;
  /** Real ground resolution of the analysis grid. */
  metersPerPixel: number;
  /** True when the grid is coarser than the native 10 m (large areas). */
  coarse: boolean;
  sensitivity: Sensitivity;
  minPatchHa: number;
  /** Engine that produced this result (CHANGE_ENGINE). */
  engine: CompareEngine;
  /** Rule mode that produced this result (CHANGE_RULES; omitted pre-Phase 3). */
  rules?: CompareRulesMode;
  /** Fused evidence actually available (CHANGE_RULES=fused only). */
  evidence?: EvidenceMeta;
  /** True when SHARPEN_SWIR regression sharpening ran on the composite (v2). */
  sharpen?: boolean;
  /** Input mode used for both sides ("single" = v1-style one-day fetch). */
  inputMode: CompareInputMode;
  /** ±days composite window per side; 0 when inputMode is "single". */
  compositeWindowDays: number;
  /** Estimated CDSE processing units for both renders (cost model, audit §5). */
  estimatedPu: number;
  /** Threshold values actually applied (after sensitivity scaling). */
  thresholds: Record<string, number>;
  /** v2 only: engine diagnostics (normalisation, co-reg, adaptive scales, …). */
  engineStats?: EngineStats;
  generatedAt: string;
}

export interface CompareStats {
  metadata: CompareMetadata;
  classes: ClassStat[];
  /** Valid (analysable) pixels as % of the polygon area. */
  validPct: number;
  /** Total pixels inside the polygon × pixel area (ha). */
  areaHa: number;
  validHa: number;
  /** Sum of all change classes (ha). */
  changedHa: number;
  tehsils: TehsilZonalStat[] | null;
  hotspots: Hotspot[];
  /** Union bbox of all detected change pixels [west, south, east, north]; null when no change. */
  changeBbox: [number, number, number, number] | null;
  /** True when no change survived the thresholds + minimum mapping unit. */
  negligible: boolean;
  /** v2 only: change pixels per confidence tier (UI filter counts). */
  confidence?: { high: number; medium: number; low: number };
  /** Total patch-vector events stored with this analysis (the client ships the
   *  first ANALYZE_EVENTS_CAP of them; more pages come from /api/compare/events). */
  eventsTotal?: number;
}

/** Result of an /api/compare/analyze call (final NDJSON frame). */
export interface AnalyzeResponse {
  key: string;
  overlayUrl: string;
  aiEnabled: boolean;
  stats: CompareStats;
  /**
   * Full-coverage change events for the Events list + map markers (largest
   * first), capped at ANALYZE_EVENTS_CAP. stats.eventsTotal carries the
   * uncapped count — further pages come from GET /api/compare/events.
   */
  events: GeoJSON.Feature[];
}

/** Structured AI summary the /api/compare/summary route returns. */
export interface SummaryData {
  overview: string;
  keyChanges: string[];
  whereChangesOccurred: string[];
  visualObservations: string[];
  reliabilityAndCaveats: string[];
  suggestedNextChecks: string[];
}

export type SummaryLanguage = "en" | "hi";
