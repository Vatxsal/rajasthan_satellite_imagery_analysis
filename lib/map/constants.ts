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

export const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

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
