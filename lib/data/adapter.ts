import type { CompositeId, District, Ilr, Scene, SearchParams, Tehsil } from "./types";

/** Descriptor for fetching a scene image (POST-with-body or GET). */
export interface SceneImageRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Single boundary between the UI and the catalogue/geometry backend.
 *
 * The dashboard only ever talks to this interface (via the `dataAdapter`
 * singleton exported from `@/lib/data`). Swap the implementation in
 * `lib/data/index.ts` to point at a real backend (STAC, PostGIS, REST, ...)
 * without touching any component or store code.
 */
export interface DataAdapter {
  getDistricts(): Promise<District[]>;
  getTehsils(districtId: string): Promise<Tehsil[]>;
  getIlrs(tehsilId: string): Promise<Ilr[]>;
  searchScenes(params: SearchParams): Promise<Scene[]>;
  /**
   * Optional: request for a scene clipped to a polygon (used by the map to
   * overlay live imagery). When absent, the map keeps the mock placeholder.
   */
  getSceneImage?(
    scene: Scene,
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
    composite: CompositeId,
  ): SceneImageRequest;
}
