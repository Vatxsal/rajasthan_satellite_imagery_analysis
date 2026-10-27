/**
 * Polygon rasterization for the analysis grid: pixel-centre even-odd scanline
 * fill. Grid columns/rows map the bbox linearly (see AnalysisGrid), so this is
 * pure geometry — no projection involved.
 */
import type { AnalysisGrid } from "./types";

type Ring = [number, number][];

interface Polygon {
  exterior: Ring;
  holes: Ring[];
}

function isPolygon(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): geometry is GeoJSON.Polygon {
  return geometry.type === "Polygon";
}

function toPolygons(geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): Polygon[] {
  if (isPolygon(geometry)) {
    const [exterior, ...holes] = geometry.coordinates;
    return [{ exterior: exterior as Ring, holes: holes as Ring[] }];
  }
  return geometry.coordinates.map(([exterior, ...holes]) => ({
    exterior: exterior as Ring,
    holes: holes as Ring[],
  }));
}

/** Scanline intersections of a ring at row centre latitude → crossing columns. */
function ringCrossings(ring: Ring, y: number, grid: AnalysisGrid): number[] {
  const crossings: number[] = [];
  const { bbox } = grid;
  const pxLon = grid.pxLon;
  const west = bbox[0];
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    // Half-open rule: edge is active when the row lies between its endpoints.
    if (y1 > y !== y2 > y) {
      const x = x1 + ((y - y1) / (y2 - y1)) * (x2 - x1);
      crossings.push((x - west) / pxLon);
    }
  }
  crossings.sort((a, b) => a - b);
  return crossings;
}

/** Even-odd fill of one polygon (exterior + holes) into a 0/1 buffer. */
function fillPolygon(polygon: Polygon, mask: Uint8Array, grid: AnalysisGrid): void {
  const { width, height, bbox } = grid;
  const pxLat = grid.pxLat;
  const north = bbox[3];
  const allRings: Ring[] = [polygon.exterior, ...polygon.holes];
  for (let row = 0; row < height; row++) {
    const lat = north - (row + 0.5) * pxLat;
    // Even-odd across ALL rings of this polygon: exterior and holes share one
    // crossing list, so holes correctly punch out of the exterior.
    const crossings: number[] = [];
    for (const ring of allRings) crossings.push(...ringCrossings(ring, lat, grid));
    crossings.sort((a, b) => a - b);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const colStart = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const colEnd = Math.min(width - 1, Math.floor(crossings[k + 1] - 0.5));
      for (let col = colStart; col <= colEnd; col++) mask[row * width + col] = 1;
    }
  }
}

/** 1 where the pixel centre falls inside the polygon, else 0. */
export function rasterizeAreaMask(
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon,
  grid: AnalysisGrid,
): Uint8Array {
  const mask = new Uint8Array(grid.width * grid.height);
  for (const polygon of toPolygons(geometry)) fillPolygon(polygon, mask, grid);
  return mask;
}

/**
 * Rasterizes a set of zones (tehsils) onto the same grid. Returns the zone
 * index+1 per pixel, 0 = outside every zone. First-come wins on shared edges,
 * so results are deterministic. `zones` should be pre-filtered to those
 * intersecting the AOI (server does the filtering).
 */
export function rasterizeZones(
  zones: Array<{ id: string; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }>,
  grid: AnalysisGrid,
): Int16Array {
  const out = new Int16Array(grid.width * grid.height);
  zones.forEach((zone, index) => {
    const single = rasterizeAreaMask(zone.geometry, grid);
    const tag = index + 1;
    for (let i = 0; i < out.length; i++) {
      if (single[i] === 1 && out[i] === 0) out[i] = tag;
    }
  });
  return out;
}

/** Pixel centre → lon/lat (linear, exact for the Process grid). */
export function pixelToLngLat(col: number, row: number, grid: AnalysisGrid): [number, number] {
  const lon = grid.bbox[0] + (col + 0.5) * grid.pxLon;
  const lat = grid.bbox[3] - (row + 0.5) * grid.pxLat;
  return [lon, lat];
}

/** Outer pixel edges → lon/lat bbox. */
export function pixelEdgesToBbox(col: number, row: number, grid: AnalysisGrid): [number, number, number, number] {
  const west = grid.bbox[0] + col * grid.pxLon;
  const east = west + grid.pxLon;
  const north = grid.bbox[3] - row * grid.pxLat;
  const south = north - grid.pxLat;
  return [west, south, east, north];
}
