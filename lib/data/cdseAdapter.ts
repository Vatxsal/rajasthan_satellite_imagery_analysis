import type { DataAdapter, SceneImageRequest } from "./adapter";
import { mockAdapter } from "./mockAdapter";
import type { CompositeId, Scene, SearchParams } from "./types";

/** Base URL for API calls (same-origin in the app). */
const API_BASE = "/api";

interface ApiErrorBody {
  code?: string;
  message?: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let errBody: ApiErrorBody = {};
    try {
      errBody = (await response.json()) as ApiErrorBody;
    } catch {
      // ignore JSON parse errors
    }
    const error = new Error(errBody.message ?? `Request failed (${response.status})`) as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = errBody.code;
    throw error;
  }

  return (await response.json()) as T;
}

interface ScenesResponse {
  scenes: Scene[];
}

/**
 * Live CDSE/Sentinel Hub adapter. Boundaries (districts/tehsils/ILRs) still
 * come from the local mock geojson; scene search and imagery hit the
 * /api/scenes and /api/imagery routes (which hold the CDSE credentials
 * server-side).
 */
export const cdseAdapter: DataAdapter = {
  getDistricts: () => mockAdapter.getDistricts(),
  getTehsils: (districtId) => mockAdapter.getTehsils(districtId),
  getIlrs: (tehsilId) => mockAdapter.getIlrs(tehsilId),

  async searchScenes(params: SearchParams): Promise<Scene[]> {
    const { scenes } = await postJson<ScenesResponse>("/scenes", params);
    return scenes;
  },

  getSceneImage(
    scene: Scene,
    geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
    composite: CompositeId,
  ): SceneImageRequest {
    // POST with the clip geometry in the body — district polygons are far too
    // large for a query string.
    return {
      url: `${API_BASE}/imagery`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ geometry, date: scene.date, composite, size: 1024 }),
    };
  },
};
