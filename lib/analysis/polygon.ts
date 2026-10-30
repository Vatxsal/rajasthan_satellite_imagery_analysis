/**
 * Patch-outline tracing: converts the pixels of one labelled change patch into
 * a GeoJSON MultiPolygon (EPSG:4326) for map display and GeoJSON export.
 *
 * Method (Phase 3, audit weakness #12): every exposed pixel edge becomes a
 * directed segment (consistent winding for a y-down pixel grid), segments are
 * chained into closed rings — at junctions the outgoing segment is paired with
 * the rightmost turn, which separates diagonal-only ("pinch") contacts into
 * two simple rings instead of one self-touching figure-8 — then rings are
 * grouped into outer/hole polygons by containment, simplified with
 * Douglas-Peucker (0.5 px) to kill stair-steps, and rounded with Chaikin
 * corner-cutting. Pure maths — no dependencies, safe for the server analysis
 * path and the node test build. Areas/statistics never use these vertices:
 * they stay pixel-derived in stats.ts.
 */
import { POLYGON_SIMPLIFY_PX, POLYGON_SMOOTH_PASSES } from "./config";
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

interface Segment {
  sx: number;
  sy: number;
  ex: number;
  ey: number;
}

/**
 * Chains directed boundary segments into closed rings. At a vertex where more
 * than one segment starts (diagonal pixel pinch), the outgoing segment is
 * chosen by the rightmost turn relative to the incoming direction — the
 * winding-consistent pairing that keeps each lobe on its own simple ring.
 * Returns the rings plus the number of chains that failed to close (should be
 * 0 for any patch derived from a raster).
 */
function traceRings(pixels: Int32Array | number[], width: number, present: Set<number>): {
  rings: Ring[];
  dropped: number;
} {
  const starts = new Map<string, Segment[]>();
  const push = (sx: number, sy: number, ex: number, ey: number): void => {
    const key = `${sx},${sy}`;
    let list = starts.get(key);
    if (!list) {
      list = [];
      starts.set(key, list);
    }
    list.push({ sx, sy, ex, ey });
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
  let dropped = 0;
  starts.forEach((list) => {
    while (list.length > 0) {
      const first = list.pop()!;
      const ring: Ring = [[first.sx, first.sy]];
      let cx = first.ex;
      let cy = first.ey;
      let inX = first.ex - first.sx;
      let inY = first.ey - first.sy;
      let closed = false;
      let guard = 0;
      while (guard++ < 4_000_000) {
        if (cx === first.sx && cy === first.sy) {
          closed = true;
          break;
        }
        ring.push([cx, cy]);
        const candidates = starts.get(`${cx},${cy}`);
        let next: Segment | undefined;
        if (candidates && candidates.length > 0) {
          if (candidates.length === 1) {
            next = candidates.pop();
          } else {
            // Junction (diagonal pinch): rightmost turn wins (cross > 0 first).
            let bestCross = -2;
            let bestIdx = -1;
            for (let ci = 0; ci < candidates.length; ci++) {
              const cand = candidates[ci];
              const outX = cand.ex - cand.sx;
              const outY = cand.ey - cand.sy;
              const cross = inX * outY - inY * outX;
              if (cross > bestCross) {
                bestCross = cross;
                bestIdx = ci;
              }
            }
            next = candidates.splice(bestIdx, 1)[0];
          }
        }
        if (!next) break; // open chain — should not happen for raster patches
        inX = next.ex - next.sx;
        inY = next.ey - next.sy;
        cx = next.ex;
        cy = next.ey;
      }
      if (closed && ring.length >= 4) rings.push(ring);
      else dropped += 1;
    }
  });
  return { rings, dropped };
}

/** Douglas-Peucker on the open chain [P0 … Pn-1, P0]; result stays closed (no duplicate end). */
function simplifyRing(ring: Ring, tol: number): Ring {
  const n = ring.length;
  if (n <= 4 || tol <= 0) return ring;
  const pts: Vertex[] = [...ring, ring[0]];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [s, e] = stack.pop()!;
    const [x1, y1] = pts[s];
    const [x2, y2] = pts[e];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let maxDist = -1;
    let maxIdx = -1;
    for (let i = s + 1; i < e; i++) {
      const [px, py] = pts[i];
      const dist =
        len2 === 0
          ? Math.sqrt((px - x1) ** 2 + (py - y1) ** 2)
          : Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / Math.sqrt(len2);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxIdx >= 0 && maxDist > tol) {
      keep[maxIdx] = 1;
      stack.push([s, maxIdx], [maxIdx, e]);
    }
  }
  const out: Ring = [];
  for (let i = 0; i < pts.length - 1; i++) if (keep[i] === 1) out.push(pts[i]);
  return out.length >= 3 ? out : ring;
}

/** One Chaikin corner-cutting pass over a closed ring (rounds stair corners). */
function chaikin(ring: Ring): Ring {
  const n = ring.length;
  if (n < 3) return ring;
  const out: Ring = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    out.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
    out.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
  }
  return out;
}

/** Simplify stair-steps away, then round corners (Phase 3 smoothing). */
function smoothRing(ring: Ring): Ring {
  let out = simplifyRing(ring, POLYGON_SIMPLIFY_PX);
  for (let pass = 0; pass < POLYGON_SMOOTH_PASSES; pass++) out = chaikin(out);
  return out;
}

/**
 * Traces one patch (pixel indices) into a MultiPolygon: rings are sorted by
 * area, ring 0 starts the first outer polygon, any later ring contained in an
 * outer becomes its hole, otherwise it opens a new outer polygon. Rings are
 * smoothed for display and closed per RFC 7946 (first position repeated last).
 */
export function patchToMultiPolygon(
  pixels: Int32Array | number[],
  width: number,
  grid: AnalysisGrid,
): GeoJSON.MultiPolygon | null {
  if (pixels.length === 0) return null;
  const present = new Set<number>();
  for (let k = 0; k < pixels.length; k++) present.add(pixels[k]);

  const { rings } = traceRings(pixels, width, present);
  if (rings.length === 0) return null;

  rings.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));

  const { bbox, pxLon, pxLat } = grid;
  const toLngLat = (ring: Ring): GeoJSON.Position[] => {
    const coords: GeoJSON.Position[] = ring.map(([x, y]) => [
      bbox[0] + x * pxLon,
      bbox[3] - y * pxLat,
    ]);
    if (coords.length > 0) coords.push([...coords[0]]); // RFC 7946 closure
    return coords;
  };

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
    coordinates: outers.map((ringsOfPolygon) => ringsOfPolygon.map((r) => toLngLat(smoothRing(r)))),
  };
}
