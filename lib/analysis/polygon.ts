/**
 * Patch-outline tracing: converts the pixels of one labelled change patch into
 * a GeoJSON MultiPolygon (EPSG:4326) for map display and GeoJSON export.
 *
 * Method: every exposed pixel edge becomes a directed segment (consistent
 * winding for a y-down pixel grid), segments are chained into closed rings,
 * then rings are grouped into outer/hole polygons by containment. Pure maths —
 * no dependencies, safe for the server analysis path and the node test build.
 */
import type { AnalysisGrid } from "./types";

type Vertex = [number, number];
type Ring = Vertex[];

/** Ray-cast point-in-ring (even-odd). */
function ringContains(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return sum / 2;
}

/**
 * Builds directed boundary segments for a set of pixels (indices into a
 * width-wide raster) and chains them into closed rings in edge coordinates.
 */
function traceRings(pixels: Int32Array | number[], width: number, present: Set<number>): Ring[] {
  const starts = new Map<string, Array<[number, number, number, number]>>();
  const push = (
    sx: number,
    sy: number,
    ex: number,
    ey: number,
  ): void => {
    const key = `${sx},${sy}`;
    let list = starts.get(key);
    if (!list) {
      list = [];
      starts.set(key, list);
    }
    list.push([sx, sy, ex, ey]);
  };

  for (let k = 0; k < pixels.length; k++) {
    const i = pixels[k];
    const col = i % width;
    const row = (i - col) / width;
    if (!present.has(i - width)) push(col, row, col + 1, row); // top
    if (!present.has(i + 1) || col === width - 1) push(col + 1, row, col + 1, row + 1); // right
    if (!present.has(i + width)) push(col + 1, row + 1, col, row + 1); // bottom
    if (col === 0 || !present.has(i - 1)) push(col, row + 1, col, row); // left
  }

  const rings: Ring[] = [];
  starts.forEach((firstList) => {
    while (firstList.length > 0) {
      const first = firstList.pop()!;
      const ring: Ring = [[first[0], first[1]]];
      let cx = first[2];
      let cy = first[3];
      let closed = false;
      let guard = 0;
      while (guard++ < 4_000_000) {
        if (cx === first[0] && cy === first[1]) {
          closed = true;
          break;
        }
        ring.push([cx, cy]);
        const list = starts.get(`${cx},${cy}`);
        const next = list && list.length > 0 ? list.pop() : undefined;
        if (!next) break; // open chain — drop (never happens for closed patches)
        cx = next[2];
        cy = next[3];
      }
      if (closed && ring.length >= 4) rings.push(ring);
    }
  });
  return rings;
}

/**
 * Traces one patch (pixel indices) into a MultiPolygon: rings are sorted by
 * area, ring 0 starts the first outer polygon, any later ring contained in an
 * outer becomes its hole, otherwise it opens a new outer polygon.
 */
export function patchToMultiPolygon(
  pixels: Int32Array | number[],
  width: number,
  grid: AnalysisGrid,
): GeoJSON.MultiPolygon | null {
  if (pixels.length === 0) return null;
  const present = new Set<number>();
  for (let k = 0; k < pixels.length; k++) present.add(pixels[k]);

  const rings = traceRings(pixels, width, present);
  if (rings.length === 0) return null;

  rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));

  const { bbox, pxLon, pxLat } = grid;
  const toLngLat = (ring: Ring): GeoJSON.Position[] =>
    ring.map(([x, y]) => [bbox[0] + x * pxLon, bbox[3] - y * pxLat]);

  const outers: Ring[][] = [];
  for (const ring of rings) {
    let placed = false;
    for (const candidate of outers) {
      const outer = candidate[0];
      if (ringContains(outer, ring[0][0], ring[0][1])) {
        candidate.push(ring);
        placed = true;
        break;
      }
    }
    if (!placed) outers.push([ring]);
  }

  return {
    type: "MultiPolygon",
    coordinates: outers.map((ringsOfPolygon) => ringsOfPolygon.map(toLngLat)),
  };
}
