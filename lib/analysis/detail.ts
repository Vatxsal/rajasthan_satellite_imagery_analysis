/**
 * Phase 3 — detailed (tiled, native-resolution) comparison: pure block
 * planning, smart screening, seam union-find and tile geometry.
 *
 * A detailed run splits the AOI's native 10 m grid into 1024² blocks with a
 * 32 px context margin, classifies each block independently (aligned to the
 * AOI grid so block pixels map 1:1 onto AOI pixels), then stitches the
 * results: patches that cross a seam are united through the overlap strips
 * (union-find over `(blockIndex, label)` ids) and tiles are assembled from
 * the owning block's core region — cores are disjoint and cover the grid, so
 * no pixel is counted twice and the artificial block-edge erosion never
 * leaks into the output.
 *
 * Everything here is pure arithmetic over typed arrays — no I/O, no env —
 * so the node test harness exercises exactly what the detail run executes.
 */
import type { BBox } from "@/lib/data";
import { computeOutputSize, PROCESS_MAX_OUTPUT_PX } from "../cdse/geometry";
import { CLASS, GRID_MIN_PX, MAGNITUDE_SCALE } from "./config";
import { makeAnalysisGrid, nativeLongSidePx } from "./grid";
import type { AnalysisGrid } from "./types";

/** Native block edge (px) before the context margin. */
export const DETAIL_BLOCK_PX = 1024;
/** Context margin (px) added around each core so despeckle/labels see past
 *  the seam; overlap between neighbouring expanded regions = 2× this. */
export const DETAIL_OVERLAP_PX = 32;
/** gid = blockIndex·STRIDE + localLabel — local labels stay well below this. */
export const DETAIL_LABEL_STRIDE = 1 << 24;
/** Fraction of the strongest screening pixels always refined (top 5%). */
export const DETAIL_SCREEN_TOP_PCT = 0.05;
/** A screening pixel is hot above this share of its applied threshold. */
export const DETAIL_SCREEN_THRESHOLD_SHARE = 0.6;

/**
 * Screening raster size for smart mode: ~1/4 native (≈40 m at 10 m native),
 * capped at the Sentinel Hub Process API output limit (2500 px per side —
 * a district at native ÷ 4 easily asks for 6000+ px, which the API refuses
 * with COMMON_BAD_PAYLOAD). Large AOIs therefore screen coarser than 40 m
 * and the effective resolution rides the estimate card + metadata.
 */
export function screeningSize(bbox: BBox): {
  width: number;
  height: number;
} {
  const native = Math.max(GRID_MIN_PX, Math.floor(nativeLongSidePx(bbox)));
  const cap = Math.min(PROCESS_MAX_OUTPUT_PX, native);
  return computeOutputSize(bbox, cap);
}

export interface DetailBlock {
  index: number;
  /** Lattice coordinates (column-major of blockPx). */
  i: number;
  j: number;
  /** Owned region in AOI-grid px: [x0, y0, x1, y1) — disjoint, full cover. */
  core: [number, number, number, number];
  /** core ± DETAIL_OVERLAP_PX, clamped to the grid — what gets fetched. */
  expanded: [number, number, number, number];
  /** Lon/lat bbox of the expanded region (grid-aligned, for the render). */
  bbox: BBox;
  /** Expanded pixel dims (exact render size — maps 1:1 onto AOI pixels). */
  width: number;
  height: number;
}

export interface DetailPlan {
  /** Full native-resolution AOI grid the blocks tile. */
  grid: AnalysisGrid;
  cols: number;
  rows: number;
  blockPx: number;
  overlapPx: number;
  /** Row-major (j·cols + i). */
  blocks: DetailBlock[];
}

function rectRing(bbox: BBox): GeoJSON.Polygon {
  const [w, s, e, n] = bbox;
  return {
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

/** Clip geometry of one block's expanded region (the block's render input). */
export function blockGeometry(block: DetailBlock): GeoJSON.Polygon {
  return rectRing(block.bbox);
}

/** Global patch id for a block-local label (0 stays "no patch"). */
export function detailGid(blockIndex: number, label: number): number {
  if (label <= 0) return 0;
  return blockIndex * DETAIL_LABEL_STRIDE + label;
}

/**
 * Plans the block lattice over the AOI at native 10 m: the grid long side is
 * the honest native pixel count (never upscaled), cores tile it exactly and
 * each expanded region adds the context margin (clipped at the AOI edge).
 */
export function planDetail(
  bbox: BBox,
  blockPx: number = DETAIL_BLOCK_PX,
  overlapPx: number = DETAIL_OVERLAP_PX,
): DetailPlan {
  const native = Math.max(GRID_MIN_PX, Math.floor(nativeLongSidePx(bbox)));
  const { width, height } = computeOutputSize(bbox, native);
  const grid = makeAnalysisGrid(bbox, width, height);
  const cols = Math.ceil(width / blockPx);
  const rows = Math.ceil(height / blockPx);
  const blocks: DetailBlock[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const cx0 = i * blockPx;
      const cx1 = Math.min(cx0 + blockPx, width);
      const cy0 = j * blockPx;
      const cy1 = Math.min(cy0 + blockPx, height);
      const ex0 = Math.max(0, cx0 - overlapPx);
      const ey0 = Math.max(0, cy0 - overlapPx);
      const ex1 = Math.min(width, cx1 + overlapPx);
      const ey1 = Math.min(height, cy1 + overlapPx);
      blocks.push({
        index: blocks.length,
        i,
        j,
        core: [cx0, cy0, cx1, cy1],
        expanded: [ex0, ey0, ex1, ey1],
        bbox: [
          grid.bbox[0] + ex0 * grid.pxLon,
          grid.bbox[3] - ey1 * grid.pxLat,
          grid.bbox[0] + ex1 * grid.pxLon,
          grid.bbox[3] - ey0 * grid.pxLat,
        ],
        width: ex1 - ex0,
        height: ey1 - ey0,
      });
    }
  }
  return { grid, cols, rows, blockPx, overlapPx, blocks };
}

/** The block whose core owns an AOI-grid pixel (null outside the lattice). */
export function ownerBlock(plan: DetailPlan, col: number, row: number): DetailBlock | null {
  if (col < 0 || row < 0 || col >= plan.grid.width || row >= plan.grid.height) return null;
  const i = Math.floor(col / plan.blockPx);
  const j = Math.floor(row / plan.blockPx);
  const block = plan.blocks[j * plan.cols + i];
  return block ?? null;
}

/* ------------------------------------------------------------------ */
/* Smart screening                                                     */
/* ------------------------------------------------------------------ */

/**
 * Screening ratios from the stored combined magnitude plane: it already
 * holds the dominant |Δ_i| / threshold_i (× MAGNITUDE_SCALE, signed by the
 * dominant index — diagnostics.ts magnitudePlanes), so one plane is enough.
 * Pixels outside the polygon or without data are forced to 0.
 */
export function combinedRatio(
  combined: Int8Array,
  classGrid?: Uint8Array | null,
): Float32Array {
  const n = combined.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (classGrid && (classGrid[i] === CLASS.outside || classGrid[i] === CLASS.masked)) continue;
    out[i] = Math.abs(combined[i]) / MAGNITUDE_SCALE;
  }
  return out;
}

/** Value at (or above) which the top `pct` share of pixels sit (0 if empty). */
export function topPercentileCutoff(values: Float32Array, pct: number): number {
  // Ratios are bounded small (≤ ~8 covers any plausible threshold); bucket
  // 0…8 in 1/16 steps — far cheaper than sorting hundreds of thousands.
  const BUCKETS = 129;
  const hist = new Uint32Array(BUCKETS);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!(v > 0)) continue;
    const b = Math.min(BUCKETS - 1, Math.round(v * 16));
    hist[b] += 1;
    n += 1;
  }
  if (n === 0) return 0;
  const want = Math.max(1, Math.ceil(n * pct));
  let acc = 0;
  for (let b = BUCKETS - 1; b >= 1; b--) {
    acc += hist[b];
    if (acc >= want) return (b - 0.5) / 16;
  }
  return 1 / 16;
}

export interface DetailScreening {
  /** Screening raster dims (covers the same bbox, coarser). */
  width: number;
  height: number;
  /** Per-pixel ratio in threshold units (screeningRatio). */
  ratio: Float32Array;
}

/**
 * Smart mode block selection: a block is refined when a hot screening pixel
 * falls in its core, or when it neighbours a hot block (+1-block buffer so
 * seam-crossing patches keep both sides). Hot = ratio above
 * DETAIL_SCREEN_THRESHOLD_SHARE of the applied threshold OR in the top
 * DETAIL_SCREEN_TOP_PCT of the whole scene (whichever cutoff is higher).
 *
 * Returns the selected block indexes; empty when the scene has no change.
 */
export function screenDetailBlocks(plan: DetailPlan, screening: DetailScreening): Set<number> {
  const { width, height, ratio } = screening;
  const cutoff = Math.max(
    DETAIL_SCREEN_THRESHOLD_SHARE,
    topPercentileCutoff(ratio, DETAIL_SCREEN_TOP_PCT),
  );
  const hotCore = new Set<number>();
  for (let r = 0; r < height; r++) {
    const row = Math.floor((r / height) * plan.grid.height);
    for (let c = 0; c < width; c++) {
      const v = ratio[r * width + c];
      if (!(v >= cutoff)) continue;
      const col = Math.floor((c / width) * plan.grid.width);
      const block = ownerBlock(plan, col, row);
      if (block) hotCore.add(block.index);
    }
  }
  if (hotCore.size === 0) return new Set();
  // +1 lattice buffer (8-neighbourhood) around every hot core block.
  const selected = new Set<number>();
  for (const index of hotCore) {
    const block = plan.blocks[index];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = block.i + di;
        const j = block.j + dj;
        if (i < 0 || j < 0 || i >= plan.cols || j >= plan.rows) continue;
        selected.add(j * plan.cols + i);
      }
    }
  }
  return selected;
}

/* ------------------------------------------------------------------ */
/* Seam union-find                                                     */
/* ------------------------------------------------------------------ */

/** One block's expanded label raster positioned in AOI-grid coordinates. */
export interface DetailBlockRaster {
  index: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  labels: Int32Array;
}

/**
 * Union-find over `(blockIndex, label)` ids built from the overlap strips of
 * every overlapping block pair: the same physical patch seen by both sides
 * of a seam gets one root. Returns the union list (serialisable; rebuild
 * with unionRoots on demand).
 */
export function seamUnionPairs(rasters: readonly DetailBlockRaster[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root)!;
    // path compression
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, root);
      cur = next;
    }
    parent.set(id, root);
    return root;
  };
  const union = (a: number, b: number): void => {
    if (a === 0 || b === 0 || a === b) return;
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent.set(ra, rb);
    pairs.push([ra, rb]);
  };

  for (let x = 0; x < rasters.length; x++) {
    for (let y = x + 1; y < rasters.length; y++) {
      const a = rasters[x];
      const b = rasters[y];
      const ax1 = a.originX + a.width;
      const ay1 = a.originY + a.height;
      const bx1 = b.originX + b.width;
      const by1 = b.originY + b.height;
      const ox0 = Math.max(a.originX, b.originX);
      const oy0 = Math.max(a.originY, b.originY);
      const ox1 = Math.min(ax1, bx1);
      const oy1 = Math.min(ay1, by1);
      if (ox0 >= ox1 || oy0 >= oy1) continue;
      for (let row = oy0; row < oy1; row++) {
        const aRow = (row - a.originY) * a.width;
        const bRow = (row - b.originY) * b.width;
        for (let col = ox0; col < ox1; col++) {
          const la = a.labels[aRow + (col - a.originX)];
          const lb = b.labels[bRow + (col - b.originX)];
          // Labels are BLOCK-LOCAL: equal numbers in different blocks are
          // different patches — only the union-find gids decide identity.
          if (la === 0 || lb === 0) continue;
          union(detailGid(a.index, la), detailGid(b.index, lb));
        }
      }
    }
  }
  return pairs;
}

/** Rebuilds the gid → root map from a serialised union list. The final pass
 *  compresses every chain, so a single `parent.get(gid) ?? gid` resolves. */
export function unionRoots(pairs: ReadonlyArray<[number, number]>): Map<number, number> {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = parent.get(id) ?? id;
    while (root !== (parent.get(root) ?? root)) root = parent.get(root)!;
    let cur = id;
    while (cur !== root) {
      const next = parent.get(cur) ?? cur;
      parent.set(cur, root);
      cur = next;
    }
    parent.set(id, root);
    return root;
  };
  for (const [a, b] of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const id of Array.from(parent.keys())) find(id);
  return parent;
}

/* ------------------------------------------------------------------ */
/* XYZ tile geometry                                                   */
/* ------------------------------------------------------------------ */

/** Web-Mercator bounds of one XYZ tile (null when out of range). */
export function tileBoundsLonLat(z: number, x: number, y: number): BBox | null {
  const n = 2 ** z;
  if (!Number.isFinite(z) || z < 0 || x < 0 || y < 0 || x >= n || y >= n) return null;
  const lon = (xx: number): number => (xx / n) * 360 - 180;
  const lat = (yy: number): number =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

export interface PxRect {
  col0: number;
  row0: number;
  /** Exclusive. */
  col1: number;
  row1: number;
}

/**
 * Tile footprint in AOI-grid pixels (clamped, half-open). Rows run north →
 * south like the grid. Null when the tile misses the AOI entirely.
 */
export function tilePxRect(grid: AnalysisGrid, z: number, x: number, y: number): PxRect | null {
  const bounds = tileBoundsLonLat(z, x, y);
  if (!bounds) return null;
  const [w, s, e, n] = bounds;
  const gw = grid.bbox[0];
  const gs = grid.bbox[1];
  const ge = grid.bbox[2];
  const gn = grid.bbox[3];
  if (e <= gw || w >= ge || n <= gs || s >= gn) return null;
  const col0 = Math.max(0, Math.floor(((Math.max(w, gw) - gw) / (ge - gw)) * grid.width));
  const col1 = Math.min(grid.width, Math.ceil(((Math.min(e, ge) - gw) / (ge - gw)) * grid.width));
  // rows: north (gn) → row 0; lat decreases southward.
  const row0 = Math.max(0, Math.floor(((gn - Math.min(n, gn)) / (gn - gs)) * grid.height));
  const row1 = Math.min(grid.height, Math.ceil(((gn - Math.max(s, gs)) / (gn - gs)) * grid.height));
  if (col0 >= col1 || row0 >= row1) return null;
  return { col0, row0, col1, row1 };
}
