import type { BBox } from "@/lib/data";

/**
 * XYZ (Web Mercator) tile math + EPSG:3857 conversions used by the
 * /api/tiles route. Mirrors what Copernicus Browser does: each tile is a
 * 512px Process API render bounded by the tile bbox in EPSG:3857, with the
 * area polygon (also converted to 3857) passed as bounds.geometry so pixels
 * outside the district/tehsil come out transparent. Verified live: bbox and
 * geometry MUST share the same CRS or the render is empty.
 */

/** Web Mercator half-world extent (EPSG:3857 meters). */
const MERC_MAX = 20037508.342789244;

export const TILE_MIN_ZOOM = 7;
export const TILE_MAX_ZOOM = 14;
/** 512px tiles (matches Copernicus Browser's raster output). */
export const TILE_SIZE = 512;
/** Max tiles an area's bbox may span at one zoom (quota guard). */
export const MAX_TILES_PER_AREA = 16_384;

export function lonToMercatorX(lon: number): number {
  return (lon * MERC_MAX) / 180;
}

export function latToMercatorY(lat: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return (
    (Math.log(Math.tan(((90 + clamped) * Math.PI) / 360)) / (Math.PI / 180) * MERC_MAX) / 180
  );
}

export function mercatorXToLon(x: number): number {
  return (x / MERC_MAX) * 180;
}

export function mercatorYToLat(y: number): number {
  return (180 / Math.PI) * Math.atan(Math.sinh((y / MERC_MAX) * Math.PI));
}

/** Convert a WGS84 position/geometry to EPSG:3857 meters. */
export function polygonToMercator(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  const convertRing = (ring: number[][]): number[][] =>
    ring.map(([x, y]) => [lonToMercatorX(x), latToMercatorY(y)]);
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: geometry.coordinates.map(convertRing) };
  }
  return {
    type: "MultiPolygon",
    coordinates: geometry.coordinates.map((poly) => poly.map(convertRing)),
  };
}

/** Geographic bbox of an XYZ tile (west, south, east, north). */
export function tileToBBox4326(z: number, x: number, y: number): BBox {
  const n = 2 ** z;
  const west = (x / n) * 360 - 180;
  const east = ((x + 1) / n) * 360 - 180;
  const north = mercatorYToLat((1 - (2 * y) / n) * MERC_MAX);
  const south = mercatorYToLat((1 - (2 * (y + 1)) / n) * MERC_MAX);
  return [west, south, east, north];
}

/** EPSG:3857 bbox of an XYZ tile (meters). */
export function tileToBBox3857(z: number, x: number, y: number): BBox {
  const [west, south, east, north] = tileToBBox4326(z, x, y);
  return [
    lonToMercatorX(west),
    latToMercatorY(south),
    lonToMercatorX(east),
    latToMercatorY(north),
  ];
}

/** Number of XYZ tiles a WGS84 bbox spans at zoom z (quota guard). */
export function tilesSpannedByBBox(bbox: BBox, z: number): number {
  const n = 2 ** z;
  const xMin = Math.floor(((bbox[0] + 180) / 360) * n);
  const xMax = Math.floor(((bbox[2] + 180) / 360) * n);
  const latToY = (lat: number): number => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  };
  const yMin = latToY(bbox[3]); // north edge → smaller y
  const yMax = latToY(bbox[1]);
  return (xMax - xMin + 1) * (yMax - yMin + 1);
}
