import type { BBox } from "@/lib/data";

export type ClipGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** Bounding box of a GeoJSON geometry (4326). */
export function bboxFromGeometry(geometry: GeoJSON.Geometry): BBox | null {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  const visit = (coords: unknown): void => {
    if (!Array.isArray(coords)) return;
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      const [x, y] = coords as [number, number];
      west = Math.min(west, x);
      south = Math.min(south, y);
      east = Math.max(east, x);
      north = Math.max(north, y);
      return;
    }
    for (const child of coords) visit(child);
  };

  visit((geometry as GeoJSON.Polygon).coordinates);
  if (!Number.isFinite(west)) return null;
  return [west, south, east, north];
}

/** Rough planar area in km² (good enough for quota guard rails). */
export function bboxAreaKm2(bbox: BBox): number {
  const [west, south, east, north] = bbox;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const kmPerDegLat = 110.574;
  const kmPerDegLon = 111.32 * Math.cos(midLatRad);
  return Math.abs(east - west) * kmPerDegLon * Math.abs(north - south) * kmPerDegLat;
}

/**
 * Output pixel size for a clipped render: aspect-corrected (cos-lat) with the
 * long side capped at maxSize (1024 by default).
 */
export function computeOutputSize(bbox: BBox, maxSize = 1024): { width: number; height: number } {
  const [west, south, east, north] = bbox;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const widthDeg = Math.max(1e-6, Math.abs(east - west)) * Math.cos(midLatRad);
  const heightDeg = Math.max(1e-6, Math.abs(north - south));

  let width: number;
  let height: number;
  if (widthDeg >= heightDeg) {
    width = maxSize;
    height = Math.max(1, Math.round((maxSize * heightDeg) / widthDeg));
  } else {
    height = maxSize;
    width = Math.max(1, Math.round((maxSize * widthDeg) / heightDeg));
  }
  return { width, height };
}
