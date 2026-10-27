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

export interface Hotspot {
  /** [lon, lat] centroid in EPSG:4326. */
  centroid: [number, number];
  /** Patch bbox [west, south, east, north]. */
  bbox: [number, number, number, number];
  areaHa: number;
  classCode: number;
  classLabel: string;
  tehsilName: string | null;
}

export interface CompareMetadata {
  areaName: string;
  areaLevel: "district" | "tehsil" | "ilr";
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
  /** Threshold values actually applied (after sensitivity scaling). */
  thresholds: Record<string, number>;
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
  /** True when no change survived the thresholds + minimum mapping unit. */
  negligible: boolean;
}

/** Result of an /api/compare/analyze call (final NDJSON frame). */
export interface AnalyzeResponse {
  key: string;
  overlayUrl: string;
  aiEnabled: boolean;
  stats: CompareStats;
}
