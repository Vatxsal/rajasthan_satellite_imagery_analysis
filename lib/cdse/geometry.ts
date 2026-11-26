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
 *
 * NOTE: callers feeding a Sentinel Hub Process API request must cap maxSize
 * at PROCESS_MAX_OUTPUT_PX (see assertProcessOutputSize) — but NOT every
 * caller is a Process request (the detail-block lattice grid legitimately
 * runs to tens of thousands of pixels, rendered per-block).
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

/**
 * Sentinel Hub Process API hard output limit, per request:
 * "For a Process API request, the limit is 2500*2500 pixels, if the output
 * below has larger values, you have to limit the bounding box or reduce the
 * resolution."
 * (CDSE documentation, notebook-samples/sentinelhub —
 *  documentation.dataspace.copernicus.eu; confirmed by the Process API
 *  error "output->width must be less than or equal to 2500".)
 */
export const PROCESS_MAX_OUTPUT_PX = 2500;

/**
 * Last-line validation before any Process API POST: refuses outputs wider or
 * taller than PROCESS_MAX_OUTPUT_PX so the request is never sent (no
 * processing units burned, no raw upstream JSON in the UI). Sizes fed from
 * computeOutputSize(maxSize ≤ PROCESS_MAX_OUTPUT_PX) always pass; explicit
 * grids (detail blocks, probe windows) are cheap to check.
 */
export function assertProcessOutputSize(width: number, height: number): void {
  if (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= 1 &&
    height >= 1 &&
    width <= PROCESS_MAX_OUTPUT_PX &&
    height <= PROCESS_MAX_OUTPUT_PX
  ) {
    return;
  }
  throw Object.assign(
    new Error(
      `This render would be ${width}×${height} px — Copernicus allows at most ` +
        `${PROCESS_MAX_OUTPUT_PX}×${PROCESS_MAX_OUTPUT_PX} px per request, so it was not sent. ` +
        `Pick a smaller area or a coarser resolution.`,
    ),
    { status: 400, code: "PROCESS_OUTPUT_TOO_LARGE" },
  );
}
