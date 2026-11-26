import assert from "node:assert/strict";
import test from "node:test";
import {
  blockGeometry,
  combinedRatio,
  DETAIL_BLOCK_PX,
  DETAIL_OVERLAP_PX,
  detailGid,
  DETAIL_LABEL_STRIDE,
  ownerBlock,
  planDetail,
  screenDetailBlocks,
  seamUnionPairs,
  tileBoundsLonLat,
  tilePxRect,
  topPercentileCutoff,
  unionRoots,
} from "../lib/analysis/detail";
import { prepareCompare } from "../lib/analysis/process";
import { compareCacheKey } from "../lib/cache";
import { makeAnalysisGrid } from "../lib/analysis/grid";
import type { AnalysisGrid } from "../lib/analysis/types";

/** ~10 m grid around Jalore-ish coordinates (1° ≈ 9,800 px native). */
const BBOX: [number, number, number, number] = [74.0, 25.5, 74.4, 25.8];

function assertRect(
  rect: [number, number, number, number],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  message: string,
): void {
  assert.deepEqual(rect, [x0, y0, x1, y1], message);
}

test("planDetail: cores tile the grid exactly; expanded adds the clamped margin", () => {
  const plan = planDetail(BBOX);
  const { grid, blocks } = plan;
  // Native grid: 0.4° lon × cos(25.65°) ≈ 40,270 m → ~4,027 px long side.
  assert.ok(grid.width >= 4000 && grid.width <= 4100, `native width ${grid.width}`);
  const cols = Math.ceil(grid.width / DETAIL_BLOCK_PX);
  const rows = Math.ceil(grid.height / DETAIL_BLOCK_PX);
  assert.equal(blocks.length, cols * rows);
  assert.equal(plan.cols, cols);
  assert.equal(plan.rows, rows);

  // Cores are disjoint and cover every pixel exactly once.
  const cover = new Int32Array(grid.width * grid.height);
  for (const block of blocks) {
    const [x0, y0, x1, y1] = block.core;
    assert.ok(x1 > x0 && y1 > y0, "core is non-empty");
    assert.equal(x1 - x0 <= DETAIL_BLOCK_PX, true);
    for (let row = y0; row < y1; row++) {
      for (let col = x0; col < x1; col++) {
        cover[row * grid.width + col] += 1;
      }
    }
  }
  for (let i = 0; i < cover.length; i++) {
    assert.equal(cover[i], 1, `every AOI pixel owned by exactly one core (${i})`);
  }

  // Expanded regions contain the core and add the margin (clamped at edges).
  for (const block of blocks) {
    const [cx0, cy0, cx1, cy1] = block.core;
    const [ex0, ey0, ex1, ey1] = block.expanded;
    assert.ok(ex0 <= cx0 && ey0 <= cy0 && ex1 >= cx1 && ey1 >= cy1, "expanded ⊇ core");
    assert.equal(ex0, Math.max(0, cx0 - DETAIL_OVERLAP_PX));
    assert.equal(ey0, Math.max(0, cy0 - DETAIL_OVERLAP_PX));
    assert.equal(ex1, Math.min(grid.width, cx1 + DETAIL_OVERLAP_PX));
    assert.equal(ey1, Math.min(grid.height, cy1 + DETAIL_OVERLAP_PX));
    assert.equal(block.width, ex1 - ex0);
    assert.equal(block.height, ey1 - ey0);
    // Grid-aligned bbox: pixel edges map back onto the AOI grid exactly.
    assert.ok(Math.abs(block.bbox[0] - (grid.bbox[0] + ex0 * grid.pxLon)) < 1e-12);
    assert.ok(Math.abs(block.bbox[3] - (grid.bbox[3] - ey0 * grid.pxLat)) < 1e-12);
  }

  // Interior blocks overlap their right neighbour by 2× the margin.
  const first = blocks[0];
  const right = blocks[1];
  const overlapX = first.expanded[2] - right.expanded[0];
  if (right && right.j === first.j && first.core[2] < grid.width) {
    assert.equal(overlapX, 2 * DETAIL_OVERLAP_PX, "neighbour expanded regions overlap 2×margin");
  }

  // ownerBlock resolves cores; outside the grid is null.
  const owner = ownerBlock(plan, first.core[0], first.core[1]);
  assert.equal(owner?.index, first.index);
  assert.equal(ownerBlock(plan, -1, 0), null);
  assert.equal(ownerBlock(plan, grid.width, 0), null);
});

test("planDetail: tiny AOI collapses to a single block", () => {
  const plan = planDetail([74.0, 25.5, 74.01, 25.508]);
  assert.equal(plan.blocks.length, 1);
  const only = plan.blocks[0];
  assertRect(only.core, 0, 0, plan.grid.width, plan.grid.height, "single core covers all");
  // No margin room — expanded == core.
  assert.deepEqual(only.expanded, only.core);
});

test("blockGeometry: expanded bbox as a closed ring", () => {
  const plan = planDetail(BBOX);
  const block = plan.blocks[0];
  const ring = blockGeometry(block).coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4], "closed ring");
  assert.deepEqual(ring[0], [block.bbox[0], block.bbox[1]]);
  assert.deepEqual(ring[1], [block.bbox[2], block.bbox[1]]);
});

test("detailGid: block-local labels map injectively; 0 stays 0", () => {
  assert.equal(detailGid(0, 0), 0);
  assert.equal(detailGid(3, 7), 3 * DETAIL_LABEL_STRIDE + 7);
  assert.notEqual(detailGid(3, 7), detailGid(4, 7));
  // Local labels stay far below the stride in practice.
  assert.ok(DETAIL_LABEL_STRIDE > 1_000_000);
});

test("combinedRatio: outside and masked pixels are suppressed", () => {
  const combined = Int8Array.from([64, -64, 32, 10]);
  const classGrid = Uint8Array.from([1, 255, 6, 0]); // change, outside, masked, noChange
  const ratio = combinedRatio(combined, classGrid);
  assert.equal(ratio[0], 1);
  assert.equal(ratio[1], 0);
  assert.equal(ratio[2], 0);
  assert.ok(ratio[3] > 0 && ratio[3] < 1);
});

test("topPercentileCutoff: top share of a uniform grid", () => {
  // 100 pixels at 0.5, none hotter → the top 5% cutoff sits at 0.5.
  const values = new Float32Array(100).fill(0.5);
  const cutoff = topPercentileCutoff(values, 0.05);
  assert.ok(cutoff > 0.4 && cutoff <= 0.56, `cutoff ${cutoff}`);
  // Empty grid → 0 (nothing is ever hot by magnitude).
  assert.equal(topPercentileCutoff(new Float32Array(0), 0.05), 0);
});

test("screenDetailBlocks: hot cores plus the 1-block buffer; empty when quiet", () => {
  const plan = planDetail([74.0, 25.5, 74.6, 25.9]); // ~6×4 blocks
  const width = 64;
  const height = 64;
  const ratio = new Float32Array(width * height);
  // One hot screening pixel in the first core (near the top-left corner).
  ratio[0] = 2.5;
  const selected = screenDetailBlocks(plan, { width, height, ratio });
  assert.ok(selected.size > 0, "hot core selected");
  assert.ok(selected.has(0), "owner of the hot pixel is selected");
  // Every selected block is within ±1 lattice of the hot block (0,0).
  for (const index of selected) {
    const block = plan.blocks[index];
    assert.ok(Math.abs(block.i) <= 1 && Math.abs(block.j) <= 1, `buffer only (${block.i},${block.j})`);
  }
  // Quiet scene (all ratios below the 0.6 share and no top-5% mass) → none.
  const quiet = new Float32Array(width * height).fill(0.05);
  assert.equal(screenDetailBlocks(plan, { width, height, ratio: quiet }).size, 0);
});

test("seamUnionPairs: one patch split across a seam unites; disjoint stays separate", () => {
  // Block A covers cols 0-11, block B cols 8-19 → overlap cols 8-11.
  // A patch labelled 1 spans the seam (cols 8-10 in both); label 2 is B-only.
  const labelsA = Int32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0]);
  const labelsB = Int32Array.from([1, 1, 1, 2, 0, 0, 0, 0, 1, 1, 0, 0]);
  const a = { index: 0, originX: 0, originY: 0, width: 12, height: 1, labels: labelsA };
  const b = { index: 1, originX: 8, originY: 0, width: 12, height: 1, labels: labelsB };
  const pairs = seamUnionPairs([a, b]);
  // The shared patch (label 1 in both) unions; label 2 in B has no partner.
  assert.equal(pairs.length, 1, JSON.stringify(pairs));
  const parent = unionRoots(pairs);
  const rootA = parent.get(detailGid(0, 1)) ?? detailGid(0, 1);
  const rootB = parent.get(detailGid(1, 1)) ?? detailGid(1, 1);
  assert.equal(rootA, rootB, "same physical patch → same root");
  // Label 2 of block B keeps its own identity.
  const root2 = parent.get(detailGid(1, 2)) ?? detailGid(1, 2);
  assert.notEqual(root2, rootA);
  // Non-overlapping blocks produce no pairs at all.
  const far = { index: 2, originX: 40, originY: 40, width: 4, height: 4, labels: Int32Array.from([1]) };
  assert.equal(seamUnionPairs([a, far]).length, 0);
  // Transitivity: A–B and B–C chains collapse through unionRoots.
  const c = {
    index: 2,
    originX: 16,
    originY: 0,
    width: 12,
    height: 1,
    labels: Int32Array.from([1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  };
  const chain = [...seamUnionPairs([a, b]), ...seamUnionPairs([b, c])];
  assert.ok(chain.length >= 2, "both seams produced pairs");
  const chainRoots = unionRoots(chain);
  const roots = [0, 1, 2].map((blockIndex) => {
    const gid = detailGid(blockIndex, 1);
    return chainRoots.get(gid) ?? gid;
  });
  assert.equal(new Set(roots).size, 1, "chain transitivity");
});

test("tileBoundsLonLat / tilePxRect: clamped AOI footprint, null outside", () => {
  const grid: AnalysisGrid = makeAnalysisGrid(BBOX, 512, 384);
  // z0 covers the world → the whole grid, clamped.
  const world = tilePxRect(grid, 0, 0, 0);
  assert.ok(world);
  assertRect(
    [world.col0, world.row0, world.col1, world.row1],
    0,
    0,
    512,
    384,
    "z0 covers the grid",
  );
  // A tile fully west of the AOI misses → null.
  const z = 8;
  const n = 2 ** z;
  const west = tileBoundsLonLat(z, 0, Math.floor(n / 2));
  assert.ok(west);
  assert.equal(tilePxRect(grid, z, 0, Math.floor(n / 2)), null);
  // Bad coordinates are rejected.
  assert.equal(tileBoundsLonLat(z, -1, 0), null);
  assert.equal(tileBoundsLonLat(z, n, 0), null);
});

test("prepareCompare: outputSize pins the exact raster (no aspect rounding)", () => {
  // A block-style bbox: grid-aligned sub-rectangle with a non-1:1 aspect.
  const geometry = {
    type: "Polygon" as const,
    coordinates: [
      [
        [74.0, 25.5],
        [74.04, 25.5],
        [74.04, 25.53],
        [74.0, 25.53],
        [74.0, 25.5],
      ],
    ],
  };
  const prep = prepareCompare({
    geometry,
    dateA: "2026-05-01",
    dateB: "2026-05-20",
    areaName: "Block fixture",
    areaLevel: "tehsil",
    areaId: "detail-fixture",
    sensitivity: "medium",
    outputSize: { width: 1088, height: 864 },
    maxPx: 1500,
  });
  assert.equal(prep.width, 1088);
  assert.equal(prep.height, 864);
  assert.equal(prep.grid.width, 1088);
  assert.equal(prep.grid.height, 864);
});

test("compareCacheKey: quick keys stay byte-stable; detail modes fork the key", () => {
  const base = {
    areaId: "d-jalor",
    level: "district",
    dateA: "2026-05-01",
    dateB: "2026-05-20",
    sensitivity: "medium",
    minPatchHa: 0.05,
    engine: "v1",
    inputMode: "single",
    compositeWindowDays: 0,
  };
  const quick = compareCacheKey(base);
  assert.equal(compareCacheKey({ ...base, detail: "quick" }), quick, "quick === absent detail");
  assert.equal(compareCacheKey(base), quick, "stable");
  const detailed = compareCacheKey({ ...base, detail: "detailed" });
  const smart = compareCacheKey({ ...base, detail: "smart" });
  assert.notEqual(detailed, quick);
  assert.notEqual(smart, quick);
  assert.notEqual(smart, detailed);
});
