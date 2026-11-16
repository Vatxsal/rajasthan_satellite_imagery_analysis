import type { BBox } from "@/lib/data";

export const RAJASTHAN_BBOX: BBox = [69.45, 23.05, 78.15, 30.25];

export const HOME_VIEW: { center: [number, number]; zoom: number } = {
  center: [73.8, 26.6],
  zoom: 5.3,
};

/** OpenFreeMap "positron" vector style (no API key, English labels). */
export const POSITRON_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

export const SATELLITE_BASEMAP = {
  id: "basemap-satellite",
  label: "Satellite",
  tiles: [
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  ],
  attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  maxzoom: 19,
  /** A real Esri tile used as the switcher thumbnail (Rajasthan region, z3). */
  thumbnail: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/3/5",
} as const;

export type BasemapId = "streets" | "satellite";

/** Shown by each map's AttributionControl for the boundary overlays. */
export const BOUNDARY_ATTRIBUTION =
  "Districts © OpenStreetMap contributors (ODbL) · Tehsils © Datameet / Census 2011";

export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
export const NOMINATIM_REVERSE_URL = "https://nominatim.openstreetmap.org/reverse";
/** Attribution shown wherever Nominatim data is displayed (ODbL). */
export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";

/**
 * Layer ids owned by the compare bridge (change-event polygons) and the
 * fields bridge (parcel fill/outline). Shared here so the inspector's
 * click hit-testing can query them without importing either bridge
 * (bridge → inspector must stay acyclic).
 */
export const EVENT_LAYERS = {
  fill: "compare-hotspot-fill",
  line: "compare-hotspot-line",
  hover: "compare-hotspot-hover",
} as const;

export const FIELDS_LAYERS = {
  fill: "fields-fill",
  line: "fields-line",
} as const;

export function bboxToPolygon(bbox: BBox): GeoJSON.Polygon {
  const [west, south, east, north] = bbox;
  return {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}
