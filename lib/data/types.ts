/** [west, south, east, north] */
export type BBox = [number, number, number, number];

export type CompositeId = "true-color" | "false-color" | "ndvi";

export type AreaLevel = "district" | "tehsil" | "ilr";

export interface District {
  id: string;
  name: string;
  geometry: GeoJSON.Polygon;
  bbox: BBox;
}

export interface Tehsil {
  id: string;
  name: string;
  districtId: string;
  geometry: GeoJSON.Polygon;
  bbox: BBox;
}

export interface Ilr {
  id: string;
  name: string;
  tehsilId: string;
  districtId: string;
  geometry: GeoJSON.Polygon;
  bbox: BBox;
}

/**
 * One original catalogue tile behind a (daily-mosaic) scene. The mosaic id
 * "S2_DAILY_…" is ours, so the real Sentinel-2 product name lives here — this
 * is what Copernicus Browser / Data Space need to download the full .SAFE ZIP.
 */
export interface SceneProduct {
  /** Original product id, e.g. "S2C_MSIL2A_20261002T144731_N0513_R139_T20QRF_20261002T161653". */
  id: string;
  /** Sentinel-2 MGRS tile, e.g. "T43RUM" ("" when it cannot be derived). */
  tile: string;
  /** Acquisition datetime (UTC, ISO). */
  datetime: string;
  /** 0-100 cloud cover of this tile. */
  cloudCover: number;
  satellite: string;
  /** Tile footprint (WGS84) — used to deep-link this tile in Copernicus Browser. */
  bbox: BBox;
}

export interface Scene {
  id: string;
  /** Human-facing catalogue id, e.g. "IRS-P6_LISS4_20260814_0A3F". */
  sceneId: string;
  /** Acquisition date, ISO "YYYY-MM-DD". */
  date: string;
  /** Acquisition time (UTC, ISO datetime) when known. */
  time?: string;
  /** 0-100, one decimal precision (raw eo:cloud_cover). */
  cloudCover: number;
  satellite: string;
  /** Short platform code for tooltips, e.g. "S2A". */
  platformCode?: string;
  composite: CompositeId;
  districtId: string;
  bbox: BBox;
  /** Thumbnail URL — data-URI (mock) or /api/imagery clipped render (cdse). */
  thumbnail: string;
  /** Percent of the selected area covered by this day's tiles (0-100), when known. */
  coverage?: number;
  /** Number of catalogue tiles merged into this (daily) scene. */
  tileCount?: number;
  /** Original catalogue products behind this scene, best tile first. */
  products?: SceneProduct[];
  /** Union of the day's tile footprints (hover outline / scene footprint layer). */
  footprint?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

export interface SearchParams {
  districtId?: string | null;
  tehsilId?: string | null;
  ilrId?: string | null;
  /** ISO "YYYY-MM-DD" */
  fromDate: string;
  /** ISO "YYYY-MM-DD" */
  toDate: string;
  /** 0-100 */
  maxCloudCover: number;
  composite: CompositeId;
}
