/**
 * Shared contract for the high-resolution (NRSC Bhoonidhi) imagery feature:
 * the vhr_scenes row shape as served by GET /api/vhr/scenes, consumed by the
 * Layers card and the map tile source. Pure types — safe to import from both
 * route handlers and client components.
 */

/** XYZ bounding box: [minLng, minLat, maxLng, maxLat] (EPSG:4326). */
export type VhrBBox = [number, number, number, number];

export interface VhrScene {
  /** Scene UUID — also the storage folder name and the tile-route id. */
  id: string;
  /** Friendly sensor/platform label (e.g. "ResourceSat-2 LISS-IV"). */
  sensor: string;
  /** Acquisition instant, ISO 8601. */
  acquiredAt: string;
  /** Ground resolution in metres (e.g. 5.8). */
  resolutionM: number;
  /** Native tile zoom band produced by the ingest pipeline. */
  minZoom: number;
  maxZoom: number;
  /** Scene footprint bbox — drives "covered area" and the swipe framing. */
  bbox: VhrBBox;
  /** Band names as ingested (e.g. ["green", "red", "nir"]). */
  bands: string[];
  /** Licence/attribution line from the ingest metadata (shown in the card). */
  licenseNote: string;
}

/** Query shape for GET /api/vhr/scenes?bbox=w,s,e,n */
export interface VhrScenesResponse {
  scenes: VhrScene[];
}
