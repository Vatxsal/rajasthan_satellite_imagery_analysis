import type { BBox, CompositeId } from "@/lib/data/types";

/**
 * Deep links into the public Copernicus Browser (browser.dataspace.copernicus.eu).
 *
 * Parameter names, spellings and value shapes below were taken from REAL share
 * URLs produced by the browser itself, e.g.
 *
 *   https://browser.dataspace.copernicus.eu/
 *     ?datasetId=S2_L2A_CDAS
 *     &dateMode=SINGLE
 *     &fromTime=2026-09-06T00:00:00.000Z
 *     &toTime=2026-09-06T23:59:59.999Z
 *     &lat=29.142579653924166
 *     &lng=48.32427000000004
 *     &zoom=16
 *     &layerId=1_TRUE_COLOR
 *     &themeId=DEFAULT-THEME
 *
 * `fromTime`/`toTime` always cover the whole UTC day of the acquisition, so a
 * link lands on the same scene the app is showing.
 */

export const COPERNICUS_BROWSER_BASE = "https://browser.dataspace.copernicus.eu/";

/** Sentinel-2 Level-2A dataset id used by Copernicus Browser. */
export const S2_L2A_DATASET_ID = "S2_L2A_CDAS";

/** Only theme id observed in every share URL — the browser default. */
export const DEFAULT_THEME_ID = "DEFAULT-THEME";

/**
 * Built-in visualisation layer ids (verified in share URLs for true/false
 * colour; the browser exposes NDVI under its own layer id).
 */
const LAYER_IDS: Record<CompositeId, string> = {
  "true-color": "1_TRUE_COLOR",
  "false-color": "2_FALSE_COLOR",
  ndvi: "NDVI",
};

export function layerIdFor(composite: CompositeId): string {
  return LAYER_IDS[composite] ?? "1_TRUE_COLOR";
}

export interface CopernicusBrowserParams {
  /** Area shown in the browser — its centre and zoom come from this bbox. */
  bbox: BBox;
  /** Acquisition date (YYYY-MM-DD) — opens the browser on that whole UTC day. */
  date: string;
  /** Overrides the bbox centre latitude (WGS84 degrees). */
  lat?: number;
  /** Overrides the bbox centre longitude (WGS84 degrees). */
  lng?: number;
  /** Pick the matching built-in layer; defaults to true colour. */
  composite?: CompositeId;
  /** Overrides the composite-derived layer id. */
  layerId?: string;
  /** Overrides the zoom derived from `bbox`. */
  zoom?: number;
  /** Overrides `S2_L2A_CDAS`. */
  datasetId?: string;
  /** Overrides `DEFAULT-THEME`. */
  themeId?: string;
}

function mercatorY(latDeg: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, latDeg));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI) / 360));
}

/**
 * Zoom that fits `bbox` inside a `viewportPx` square (web-mercator maths, the
 * same model Leaflet/Copernicus Browser use). Floored so the area never gets
 * cropped, clamped to the range the browser accepts.
 */
export function zoomForBBox(bbox: BBox, viewportPx = 768): number {
  const [west, south, east, north] = bbox;
  const lngSpan = Math.abs(east - west);
  const latSpan = Math.abs(mercatorY(north) - mercatorY(south));
  if (!(lngSpan > 0) || !(latSpan > 0)) return 9;

  const zLng = Math.log2((viewportPx * 360) / (256 * lngSpan));
  const zLat = Math.log2((viewportPx * Math.PI) / (256 * latSpan));
  return Math.max(1, Math.min(18, Math.floor(Math.min(zLng, zLat))));
}

/** [lng, lat] centre of a bbox (web-mercator neutral — plain mean is fine). */
export function centerOfBBox(bbox: BBox): { lat: number; lng: number } {
  const [west, south, east, north] = bbox;
  return { lat: (south + north) / 2, lng: (west + east) / 2 };
}

/**
 * Builds a Copernicus Browser URL that opens the given day, place and layer.
 * Returns a plain, copy-pasteable https URL.
 */
export function buildCopernicusBrowserUrl(params: CopernicusBrowserParams): string {
  const url = new URL(COPERNICUS_BROWSER_BASE);
  const center = centerOfBBox(params.bbox);
  const lat = params.lat ?? center.lat;
  const lng = params.lng ?? center.lng;
  const zoom = params.zoom ?? zoomForBBox(params.bbox);

  url.searchParams.set("datasetId", params.datasetId ?? S2_L2A_DATASET_ID);
  url.searchParams.set("dateMode", "SINGLE");
  url.searchParams.set("fromTime", `${params.date}T00:00:00.000Z`);
  url.searchParams.set("toTime", `${params.date}T23:59:59.999Z`);
  url.searchParams.set("lat", formatCoordinate(lat));
  url.searchParams.set("lng", formatCoordinate(lng));
  url.searchParams.set("zoom", String(zoom));
  url.searchParams.set("layerId", params.layerId ?? layerIdFor(params.composite ?? "true-color"));
  url.searchParams.set("themeId", params.themeId ?? DEFAULT_THEME_ID);

  return url.toString();
}

function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(6).replace(/\.?0+$/, "") || "0" : "0";
}
