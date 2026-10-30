import assert from "node:assert/strict";
import test from "node:test";
import { patchToMultiPolygon } from "../lib/analysis/polygon";
import type { AnalysisGrid } from "../lib/analysis/types";

/** 10 m-ish grid: 1 px = 0.0001°. */
function grid(width: number, height: number): AnalysisGrid {
  const pxLon = 0.0001;
  const pxLat = 0.0001;
  return {
    width,
    height,
    bbox: [72.0, 26.0, 72.0 + width * pxLon, 26.0 + height * pxLat],
    pxLon,
    pxLat,
    metersX: 10,
    metersY: 10,
    metersPerPixel: 10,
  };
}

function isClosed(ring: GeoJSON.Position[]): boolean {
  const a = ring[0];
  const b = ring[ring.length - 1];
  return a[0] === b[0] && a[1] === b[1];
}

function distinct(ring: GeoJSON.Position[]): number {
  return new Set(ring.map((p) => `${p[0]},${p[1]}`)).size;
}

test("patch outline: diagonal pinch → two simple closed rings, no figure-8", () => {
  const W = 5;
  const H = 5;
  const g = grid(W, H);
  // Two pixels touching only at a corner: (row1,col1) and (row2,col2).
  const pixels = [1 * W + 1, 2 * W + 2];
  const mp = patchToMultiPolygon(pixels, W, g);
  assert.ok(mp);
  assert.equal(mp.coordinates.length, 2, "each lobe gets its own polygon ring");
  for (const poly of mp.coordinates) {
    assert.equal(poly.length, 1, "no holes here");
    const ring = poly[0];
    assert.ok(isClosed(ring), "RFC 7946: first position repeated last");
    assert.ok(distinct(ring) >= 4, "simple ring — 4+ distinct corners");
  }
});

test("patch outline: solid block → one polygon, closed ring", () => {
  const W = 6;
  const g = grid(W, 6);
  const pixels: number[] = [];
  for (let r = 2; r <= 3; r++) for (let c = 2; c <= 3; c++) pixels.push(r * W + c);
  const mp = patchToMultiPolygon(pixels, W, g);
  assert.ok(mp);
  assert.equal(mp.coordinates.length, 1);
  assert.equal(mp.coordinates[0].length, 1, "single ring, no holes");
  assert.ok(isClosed(mp.coordinates[0][0]));
});

test("patch outline: interior hole survives as a second ring", () => {
  const W = 9;
  const g = grid(W, 9);
  const hole = new Set<number>();
  for (let r = 3; r <= 5; r++) for (let c = 3; c <= 5; c++) hole.add(r * W + c);
  const pixels: number[] = [];
  for (let r = 1; r <= 7; r++) {
    for (let c = 1; c <= 7; c++) {
      const i = r * W + c;
      if (!hole.has(i)) pixels.push(i);
    }
  }
  const mp = patchToMultiPolygon(pixels, W, g);
  assert.ok(mp);
  assert.equal(mp.coordinates.length, 1, "one outer polygon");
  assert.equal(mp.coordinates[0].length, 2, "outer + hole ring");
  for (const ring of mp.coordinates[0]) assert.ok(isClosed(ring));
});

test("patch outline: stair-step edges are simplified away", () => {
  const W = 24;
  const g = grid(W, 3);
  // 1×20 bar: raw tracing yields ~42 boundary vertices, all collinear per side.
  const pixels: number[] = [];
  for (let c = 1; c <= 20; c++) pixels.push(1 * W + c);
  const mp = patchToMultiPolygon(pixels, W, g);
  assert.ok(mp);
  assert.equal(mp.coordinates.length, 1);
  const ring = mp.coordinates[0][0];
  // Simplified to a rounded rectangle (≤ 16 smoothed points) far below the
  // ~43 vertices the old stair-step tracer emitted for this shape.
  assert.ok(ring.length <= 20, `expected ≤20 vertices after smoothing, got ${ring.length}`);
  assert.ok(isClosed(ring));
});
