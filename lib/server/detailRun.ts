/**
 * Phase 3 — detailed comparison orchestration: the smart screening pass,
 * per-block classification with progress/cancel, seam union-find, merged
 * stats/events and the ≤COMPARE_MAX_PX preview artifacts.
 *
 * The finished entry keeps the CompareArtifactEntry shape (the preview
 * rasters replace the quick-run grids) plus `detail` block-lattice metadata,
 * so the events/overlay/summary routes and exports work unchanged, while
 * the XYZ tile route assembles native-resolution tiles from cached blocks.
 *
 * Ownership model: every AOI pixel belongs to exactly one block CORE (cores
 * are disjoint and cover the grid), so stats never double-count the 32 px
 * context margins and tile pixels read from their owner block — the
 * artificial block-edge erosion never leaks into the output.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { join } from "node:path";
import { runCompare } from "@/lib/analysis/analyze";
import {
  blockGeometry,
  combinedRatio,
  DETAIL_SCREENING_MAX_PX,
  detailGid,
  planDetail,
  screenDetailBlocks,
  seamUnionPairs,
  tilePxRect,
  unionRoots,
  type DetailBlock,
  type DetailBlockRaster,
  type DetailPlan,
} from "@/lib/analysis/detail";
import { CLASS, CLASS_DEFS, GRID_MIN_PX, M2_PER_HA, classLabel } from "@/lib/analysis/config";
import { makeAnalysisGrid, nativeLongSidePx } from "@/lib/analysis/grid";
import { computeOutputSize } from "@/lib/cdse/geometry";
import { pixelEdgesToBbox, rasterizeZones } from "@/lib/analysis/mask";
import { patchToMultiPolygon } from "@/lib/analysis/polygon";
import { eventId } from "@/lib/analysis/events";
import {
  classToRgba,
  coverageToRgba,
  encodePng,
  gapFillToRgba,
  magnitudeToRgba,
} from "@/lib/analysis/png";
import {
  compositeSamples,
  DEM_INPUT_BANDS,
  estimateAnalysisPu,
  estimateRenderPu,
  S1_INPUT_BANDS,
  s1Samples,
  V1_INPUT_BANDS,
  V2_INPUT_BANDS,
} from "@/lib/analysis/pu";
import type { CompareArtifact, RunCompareInput } from "@/lib/analysis/process";
import type {
  AnalysisGrid,
  CompareMetadata,
  CompareStats,
  ConfidenceTier,
  Hotspot,
  TehsilZonalStat,
} from "@/lib/analysis/types";
import {
  detailBlockCache,
  detailBlockKey,
  detailResultCache,
  detailScreenCache,
  detailScreenKey,
  diskCacheGet,
  diskCacheSet,
  type CompareArtifactEntry,
  type CompareBlockEntry,
  type CompareScreenEntry,
} from "@/lib/cache";
import { ensureCached } from "@/lib/compare/ensureArtifact";
import { getServerEnv } from "@/lib/env";
import { apiError } from "@/lib/server/api";
import {
  districtZones,
  sceneMeta,
  validateScenes,
  type ResolvedCompareParams,
  type SceneHits,
} from "@/lib/server/compareRun";
import { sharedInstance } from "../singleton";

/* ------------------------------------------------------------------ */
/* Public contracts                                                    */
/* ------------------------------------------------------------------ */

/** Streamed while a detailed run progresses (mapped 1:1 to NDJSON frames). */
export type DetailProgress =
  | { stage: "screen" }
  | { stage: "block"; index: number; total: number }
  | { stage: "analyze" };

export interface EnsureDetailOptions {
  onProgress?: (progress: DetailProgress) => void;
  /** Client disconnect / cancel — checked between blocks. */
  signal?: AbortSignal;
  /** Catalogue hits already validated by the caller (the analyze route). */
  sceneHits?: SceneHits;
}

/** The estimate/confirm card served by POST /api/compare/detail/estimate. */
export interface DetailEstimate {
  detail: "detailed" | "smart";
  blocksTotal: number;
  blocksSelected: number;
  screeningPu: number;
  blocksPu: number;
  estimatedPu: number;
  /** COMPARE_MAX_BLOCKS (the lattice cap already enforced). */
  cap: number;
  /** True when the run costs more PU than one quick analysis is allowed. */
  overQuickLimit: boolean;
}

/** One XYZ tile request against a finished detailed entry. */
export interface DetailTileRequest {
  layer: "class" | "coverage" | "gapfill" | "magnitude";
  index: "ndvi" | "mndwi" | "ndbi" | "combined";
  showUnchanged: boolean;
  /** Class-layer legend toggles: these class codes render transparent. */
  hideCodes?: number[];
  z: number;
  x: number;
  y: number;
}

/** In-flight dedupe per cache (restart + tiles + events race the same keys). */
const inflightScreen = sharedInstance<Map<string, Promise<CompareScreenEntry>>>(
  "rse.detailScreenInflight",
  () => new Map(),
);
const inflightBlock = sharedInstance<Map<string, Promise<CompareBlockEntry>>>(
  "rse.detailBlockInflight",
  () => new Map(),
);
const inflightDetail = sharedInstance<Map<string, Promise<CompareArtifactEntry>>>(
  "rse.detailInflight",
  () => new Map(),
);

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function abortError(): Error & { code: string } {
  return Object.assign(new Error("Detailed run cancelled."), { code: "ABORTED" });
}

function inflateU8(gz: Buffer): Uint8Array {
  return new Uint8Array(inflateSync(gz));
}

function inflateI8(gz: Buffer): Int8Array {
  const buf = inflateSync(gz);
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function inflateI32(gz: Buffer): Int32Array {
  const buf = inflateSync(gz);
  const len = buf.byteLength >> 2;
  if (buf.byteOffset % 4 === 0) {
    return new Int32Array(buf.buffer, buf.byteOffset, len);
  }
  const out = new Int32Array(len);
  for (let i = 0; i < len; i++) out[i] = buf.readInt32LE(i * 4);
  return out;
}

function propsOf(feature: GeoJSON.Feature): Record<string, unknown> {
  return (feature.properties ?? {}) as Record<string, unknown>;
}

/** Evidence plan mirrored from compareRun (fused/ml rules → S1 + terrain). */
function evidencePlanFor(resolved: ResolvedCompareParams): RunCompareInput["evidencePlan"] {
  const env = getServerEnv();
  return resolved.rules !== "legacy"
    ? { s1WindowDays: env.S1_ENABLED ? env.S1_WINDOW_DAYS : null, terrain: true }
    : null;
}

/** The same PU arithmetic prepareCompare applies (single source for the
 *  estimate card + entry metadata). */
function analysisPu(args: {
  width: number;
  height: number;
  engine: ResolvedCompareParams["engine"];
  inputMode: ResolvedCompareParams["inputMode"];
  compositeWindowDays: number;
  evidencePlan: RunCompareInput["evidencePlan"];
}): number {
  const inputBands = args.engine === "v2" ? V2_INPUT_BANDS : V1_INPUT_BANDS;
  const samples =
    args.engine === "v2" && args.inputMode === "composite"
      ? compositeSamples(args.compositeWindowDays)
      : 1;
  let pu = estimateAnalysisPu({
    width: args.width,
    height: args.height,
    inputBands,
    float: true,
    samples,
  });
  const plan = args.evidencePlan;
  if (plan) {
    const s1Pu =
      plan.s1WindowDays != null
        ? estimateRenderPu({
            width: args.width,
            height: args.height,
            inputBands: S1_INPUT_BANDS,
            float: true,
            samples: s1Samples(plan.s1WindowDays),
          }) * 2
        : 0;
    const demPu = plan.terrain
      ? estimateRenderPu({
          width: args.width,
          height: args.height,
          inputBands: DEM_INPUT_BANDS,
          float: true,
          samples: 1,
        })
      : 0;
    pu += s1Pu + demPu;
  }
  return Math.round(pu * 100) / 100;
}

/** Screening raster size: ~40 m (native ÷ 4) capped for cost. */
export function screeningSize(bbox: [number, number, number, number]): {
  width: number;
  height: number;
} {
  const native = Math.max(GRID_MIN_PX, Math.floor(nativeLongSidePx(bbox)));
  const cap = Math.min(DETAIL_SCREENING_MAX_PX, native);
  return computeOutputSize(bbox, cap);
}

/* ------------------------------------------------------------------ */
/* Screening (smart)                                                   */
/* ------------------------------------------------------------------ */

async function ensureScreening(
  resolved: ResolvedCompareParams,
  hits?: SceneHits,
): Promise<CompareScreenEntry> {
  const env = getServerEnv();
  const { value } = await ensureCached(
    detailScreenCache,
    detailScreenKey(resolved.key),
    async (): Promise<CompareScreenEntry> => {
      const scene = hits ?? (await validateScenes(resolved));
      const size = screeningSize(resolved.area.bbox);
      const artifact = await runCompare({
        geometry: resolved.area.geometry,
        dateA: resolved.dateA,
        dateB: resolved.dateB,
        areaName: resolved.area.name,
        areaLevel: resolved.area.level,
        areaId: resolved.area.id,
        sensitivity: resolved.sensitivity,
        minPatchHa: resolved.minPatchHa,
        speckle: resolved.speckle,
        outputSize: size,
        // The screening cost rides the estimate/confirm card — not the
        // single-analysis PU cap (a 4096² district screening exceeds it).
        puLimit: 0,
        sceneA: sceneMeta(scene.hitsA),
        sceneB: sceneMeta(scene.hitsB),
        // Screening feeds block selection only — no zonal table needed.
        zones: null,
        engine: resolved.engine,
        inputMode: resolved.inputMode,
        compositeWindowDays: resolved.compositeWindowDays,
        rules: resolved.rules,
        sharpen: resolved.sharpen,
        evidencePlan: evidencePlanFor(resolved),
      });
      return {
        width: size.width,
        height: size.height,
        magnitudeGz: artifact.magnitudeGz,
        classGz: artifact.classGz,
        metadata: artifact.result.metadata,
        estimatedPu: artifact.result.metadata.estimatedPu,
      };
    },
    { inflight: inflightScreen, ttlSeconds: env.IMAGERY_CACHE_TTL_SECONDS },
  );
  return value;
}

/* ------------------------------------------------------------------ */
/* Per-block run + cache (memory LRU + optional disk persistence)       */
/* ------------------------------------------------------------------ */

function blockDiskDir(): string | undefined {
  const dir = getServerEnv().TILE_CACHE_DIR;
  return dir ? join(dir, "detail-blocks") : undefined;
}

/** detailBlockKey contains "|" — not filename-safe on every filesystem. */
function diskSafeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9-]/g, "_");
}

interface SerializedBlockEntry
  extends Omit<
    CompareBlockEntry,
    "classGz" | "coverageGz" | "sourceGz" | "labelsGz" | "magnitudeGz"
  > {
  classGz: string;
  coverageGz: string;
  sourceGz: string;
  labelsGz: string;
  magnitudeGz: { ndvi: string; mndwi: string; ndbi: string; combined: string };
}

function blockEntryToBuffer(entry: CompareBlockEntry): Buffer {
  const enc = (b: Buffer): string => b.toString("base64");
  const serialized: SerializedBlockEntry = {
    ...entry,
    classGz: enc(entry.classGz),
    coverageGz: enc(entry.coverageGz),
    sourceGz: enc(entry.sourceGz),
    labelsGz: enc(entry.labelsGz),
    magnitudeGz: {
      ndvi: enc(entry.magnitudeGz.ndvi),
      mndwi: enc(entry.magnitudeGz.mndwi),
      ndbi: enc(entry.magnitudeGz.ndbi),
      combined: enc(entry.magnitudeGz.combined),
    },
  };
  return Buffer.from(JSON.stringify(serialized), "utf8");
}

function blockEntryFromBuffer(buf: Buffer): CompareBlockEntry | null {
  try {
    const raw = JSON.parse(buf.toString("utf8")) as SerializedBlockEntry;
    const dec = (s: string): Buffer => Buffer.from(s, "base64");
    return {
      ...raw,
      classGz: dec(raw.classGz),
      coverageGz: dec(raw.coverageGz),
      sourceGz: dec(raw.sourceGz),
      labelsGz: dec(raw.labelsGz),
      magnitudeGz: {
        ndvi: dec(raw.magnitudeGz.ndvi),
        mndwi: dec(raw.magnitudeGz.mndwi),
        ndbi: dec(raw.magnitudeGz.ndbi),
        combined: dec(raw.magnitudeGz.combined),
      },
    };
  } catch {
    return null;
  }
}

/** Core-scope pixel counts for one block (owned region only — never the
 *  context margins, so merged sums never double-count). */
function computeBlockCounts(
  artifact: CompareArtifact,
  block: DetailBlock,
  zoneRaster: Int16Array | null,
): CompareBlockEntry["counts"] {
  const [cx0, cy0, cx1, cy1] = block.core;
  const [ex0, ey0] = block.expanded;
  const width = block.width;
  const classCounts = new Array<number>(256).fill(0);
  let inside = 0;
  let valid = 0;
  let changed = 0;
  let edgeChanged = 0;
  let minCol = -1;
  let maxCol = -1;
  let minRow = -1;
  let maxRow = -1;
  const tier = artifact.tiers ? { high: 0, medium: 0, low: 0 } : null;
  const zoneRows = zoneRaster
    ? new Map<
        number,
        { zoneIndex: number; inside: number; valid: number; changed: number; classCounts: number[] }
      >()
    : null;
  for (let row = cy0; row < cy1; row++) {
    const localBase = (row - ey0) * width;
    for (let col = cx0; col < cx1; col++) {
      const i = localBase + (col - ex0);
      const code = artifact.classGrid[i];
      if (code === CLASS.outside) continue;
      inside += 1;
      classCounts[code] += 1;
      if (code !== CLASS.masked) valid += 1;
      if (code >= CLASS.vegGain && code <= CLASS.waterLoss) {
        changed += 1;
        if (artifact.edgeMask && artifact.edgeMask[i] === 1) edgeChanged += 1;
        if (tier && artifact.tiers) {
          const t = artifact.tiers[i];
          if (t === 3) tier.high += 1;
          else if (t === 2) tier.medium += 1;
          else tier.low += 1;
        }
        if (minCol < 0 || col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
        if (minRow < 0 || row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
      }
      if (zoneRaster && zoneRows) {
        const z = zoneRaster[i];
        if (z > 0) {
          let zr = zoneRows.get(z);
          if (!zr) {
            zr = { zoneIndex: z, inside: 0, valid: 0, changed: 0, classCounts: new Array<number>(256).fill(0) };
            zoneRows.set(z, zr);
          }
          zr.inside += 1;
          if (code !== CLASS.masked) zr.valid += 1;
          if (code >= CLASS.vegGain && code <= CLASS.waterLoss) {
            zr.changed += 1;
            zr.classCounts[code] += 1;
          }
        }
      }
    }
  }
  return {
    classCounts,
    inside,
    valid,
    changed,
    edgeChanged,
    changedExtent: minCol >= 0 ? [minCol, minRow, maxCol, maxRow] : null,
    confidence: tier,
    zones: zoneRows ? Array.from(zoneRows.values()) : null,
  };
}

/** Runs (or loads) one block. `hits` is optional for cold tile-path
 *  recomputes — the scenes only feed block metadata, which the merged
 *  template takes from the run-time entries anyway. */
export async function ensureDetailBlock(
  resolved: ResolvedCompareParams,
  block: DetailBlock,
  hits?: SceneHits,
): Promise<CompareBlockEntry> {
  const env = getServerEnv();
  const key = detailBlockKey(resolved.key, block.index);
  const cached = detailBlockCache.get(key);
  if (cached) return cached;
  const fromDisk = (() => {
    const dir = blockDiskDir();
    if (!dir) return null;
    const buf = diskCacheGet(diskSafeKey(key), dir);
    return buf ? blockEntryFromBuffer(buf) : null;
  })();
  if (fromDisk) {
    detailBlockCache.set(key, fromDisk, env.IMAGERY_CACHE_TTL_SECONDS);
    return fromDisk;
  }
  const { value } = await ensureCached(
    detailBlockCache,
    key,
    async (): Promise<CompareBlockEntry> => {
      const zones = districtZones(resolved.area);
      const artifact = await runCompare({
        geometry: blockGeometry(block),
        dateA: resolved.dateA,
        dateB: resolved.dateB,
        areaName: resolved.area.name,
        areaLevel: resolved.area.level,
        areaId: resolved.area.id,
        sensitivity: resolved.sensitivity,
        minPatchHa: resolved.minPatchHa,
        speckle: resolved.speckle,
        outputSize: { width: block.width, height: block.height },
        ...(hits
          ? { sceneA: sceneMeta(hits.hitsA), sceneB: sceneMeta(hits.hitsB) }
          : {}),
        zones,
        engine: resolved.engine,
        inputMode: resolved.inputMode,
        compositeWindowDays: resolved.compositeWindowDays,
        rules: resolved.rules,
        sharpen: resolved.sharpen,
        evidencePlan: evidencePlanFor(resolved),
      });
      const grid = makeAnalysisGrid(block.bbox, block.width, block.height);
      const zoneRaster = zones ? rasterizeZones(zones, grid) : null;
      const entry: CompareBlockEntry = {
        index: block.index,
        core: block.core,
        expanded: block.expanded,
        bbox: block.bbox,
        width: block.width,
        height: block.height,
        classGz: artifact.classGz,
        coverageGz: artifact.coverageGz,
        sourceGz: artifact.sourceGz,
        magnitudeGz: artifact.magnitudeGz,
        labelsGz: deflateSync(Buffer.from(artifact.labels.buffer, artifact.labels.byteOffset, artifact.labels.byteLength)),
        events: artifact.patchVectors,
        counts: computeBlockCounts(artifact, block, zoneRaster),
        metadata: artifact.result.metadata,
        estimatedPu: analysisPu({
          width: block.width,
          height: block.height,
          engine: resolved.engine,
          inputMode: resolved.inputMode,
          compositeWindowDays: resolved.compositeWindowDays,
          evidencePlan: evidencePlanFor(resolved),
        }),
      };
      const dir = blockDiskDir();
      if (dir) diskCacheSet(diskSafeKey(key), blockEntryToBuffer(entry), dir);
      return entry;
    },
    { inflight: inflightBlock, ttlSeconds: env.IMAGERY_CACHE_TTL_SECONDS },
  );
  return value;
}

/* ------------------------------------------------------------------ */
/* Seam merge — events                                                 */
/* ------------------------------------------------------------------ */

/** A member feature is complete when its bbox sits ≥ ~1.5 px inside the
 *  block's expanded region — otherwise the patch may continue past the seam
 *  and gets rebuilt from the member label rasters. */
function featureIsInterior(block: CompareBlockEntry, feature: GeoJSON.Feature): boolean {
  const props = propsOf(feature);
  const bbox = props.bbox as [number, number, number, number] | undefined;
  if (!bbox) return false;
  const [bw, bs, be, bn] = block.bbox;
  const pxLon = (be - bw) / block.width;
  const pxLat = (bn - bs) / block.height;
  const m = 1.5;
  return (
    bbox[0] > bw + m * pxLon &&
    bbox[2] < be - m * pxLon &&
    bbox[1] > bs + m * pxLat &&
    bbox[3] < bn - m * pxLat
  );
}

function mergeDetailEvents(
  blocks: CompareBlockEntry[],
  plan: DetailPlan,
  unions: Array<[number, number]>,
): GeoJSON.FeatureCollection {
  const parent = unionRoots(unions);
  const find = (id: number): number => {
    let root = id;
    let next = parent.get(root);
    while (next !== undefined && next !== root) {
      root = next;
      next = parent.get(root);
    }
    return root;
  };

  const groups = new Map<
    number,
    Array<{ block: CompareBlockEntry; feature: GeoJSON.Feature; label: number; areaHa: number }>
  >();
  for (const block of blocks) {
    for (const feature of block.events.features) {
      const props = propsOf(feature);
      const label = Number(props.label);
      if (!(label > 0)) continue;
      const root = find(detailGid(block.index, label));
      let list = groups.get(root);
      if (!list) {
        list = [];
        groups.set(root, list);
      }
      list.push({ block, feature, label, areaHa: Number(props.areaHa ?? 0) });
    }
  }

  const grid = plan.grid;
  const pxAreaHa = (grid.metersX * grid.metersY) / M2_PER_HA;
  const out: GeoJSON.Feature[] = [];
  for (const [root, members] of groups) {
    if (members.length === 1 && featureIsInterior(members[0].block, members[0].feature)) {
      out.push(members[0].feature);
      continue;
    }
    // Seam-crossing / edge-touching patch: rebuild from the member pixels
    // (dedup by AOI index — the context margins see the same pixel twice).
    const seen = new Set<number>();
    const pixels: number[] = [];
    let classCode = -1;
    let edge = false;
    let minCol = grid.width;
    let maxCol = 0;
    let minRow = grid.height;
    let maxRow = 0;
    const byArea = [...members].sort((a, b) => b.areaHa - a.areaHa);
    for (const member of byArea) {
      const labels = inflateI32(member.block.labelsGz);
      const [ex0, ey0] = member.block.expanded;
      const w = member.block.width;
      for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== member.label) continue;
        const col = ex0 + (i % w);
        const row = ey0 + Math.floor(i / w);
        const aoi = row * grid.width + col;
        if (seen.has(aoi)) continue;
        seen.add(aoi);
        pixels.push(aoi);
        if (col < minCol) minCol = col;
        if (col > maxCol) maxCol = col;
        if (row < minRow) minRow = row;
        if (row > maxRow) maxRow = row;
      }
      const props = propsOf(member.feature);
      if (classCode < 0) classCode = Number(props.classCode);
      if (props.edge === true) edge = true;
    }
    if (pixels.length === 0 || classCode < 0) continue;
    const geometry = patchToMultiPolygon(pixels, grid.width, grid);
    if (!geometry) continue;
    const areaHa = Math.round(pixels.length * pxAreaHa * 100) / 100;
    const centroid: [number, number] = [
      grid.bbox[0] + ((minCol + maxCol + 1) / 2) * grid.pxLon,
      grid.bbox[3] - ((minRow + maxRow + 1) / 2) * grid.pxLat,
    ];
    const topLeft = pixelEdgesToBbox(minCol, minRow, grid);
    const bottomRight = pixelEdgesToBbox(maxCol, maxRow, grid);
    const bbox: [number, number, number, number] = [
      topLeft[0],
      bottomRight[1],
      bottomRight[2],
      topLeft[3],
    ];
    const lead = propsOf(byArea[0].feature);
    const id = eventId(classCode, root, centroid, areaHa);
    out.push({
      type: "Feature",
      id,
      geometry,
      properties: {
        id,
        label: root,
        classCode,
        classLabel: classLabel(classCode),
        areaHa,
        centroid,
        bbox,
        ...(lead.confidence ? { confidence: lead.confidence } : {}),
        ...(lead.confidencePct !== undefined ? { confidencePct: lead.confidencePct } : {}),
        ...(lead.subLabel !== undefined ? { subLabel: lead.subLabel } : {}),
        ...(Array.isArray(lead.tags) ? { tags: lead.tags } : {}),
        ...(typeof lead.tehsilName === "string" ? { tehsilName: lead.tehsilName } : {}),
        ...(edge ? { edge: true } : {}),
      },
    });
  }
  out.sort((a, b) => Number(propsOf(b).areaHa ?? 0) - Number(propsOf(a).areaHa ?? 0));
  return { type: "FeatureCollection", features: out };
}

/* ------------------------------------------------------------------ */
/* Merged stats                                                        */
/* ------------------------------------------------------------------ */

function buildMergedStats(args: {
  plan: DetailPlan;
  blocks: CompareBlockEntry[];
  events: GeoJSON.FeatureCollection;
  metadataTemplate: CompareMetadata;
  zones: Array<{ id: string; name: string }> | null;
  detail: "detailed" | "smart";
  estimatedPu: number;
}): CompareStats {
  const grid = args.plan.grid;
  const pxAreaHa = (grid.metersX * grid.metersY) / M2_PER_HA;
  const counts = new Uint32Array(256);
  let inside = 0;
  let valid = 0;
  let changed = 0;
  let edgeChanged = 0;
  let confidence: { high: number; medium: number; low: number } | null = null;
  let minCol = -1;
  let maxCol = -1;
  let minRow = -1;
  let maxRow = -1;
  const zoneMap = new Map<
    number,
    { inside: number; valid: number; changed: number; classCounts: Uint32Array }
  >();
  const gapSides = new Set<string>();
  let gapWindow = 0;
  let gapWeighted = 0;
  let gapWeight = 0;
  for (const block of args.blocks) {
    const c = block.counts;
    inside += c.inside;
    valid += c.valid;
    changed += c.changed;
    edgeChanged += c.edgeChanged;
    for (let code = 0; code < c.classCounts.length; code++) {
      counts[code] += c.classCounts[code];
    }
    if (c.confidence) {
      if (!confidence) confidence = { high: 0, medium: 0, low: 0 };
      confidence.high += c.confidence.high;
      confidence.medium += c.confidence.medium;
      confidence.low += c.confidence.low;
    }
    if (c.changedExtent) {
      const [bMinCol, bMinRow, bMaxCol, bMaxRow] = c.changedExtent;
      if (minCol < 0 || bMinCol < minCol) minCol = bMinCol;
      if (bMaxCol > maxCol) maxCol = bMaxCol;
      if (minRow < 0 || bMinRow < minRow) minRow = bMinRow;
      if (bMaxRow > maxRow) maxRow = bMaxRow;
    }
    if (c.zones) {
      for (const zr of c.zones) {
        let row = zoneMap.get(zr.zoneIndex);
        if (!row) {
          row = { inside: 0, valid: 0, changed: 0, classCounts: new Uint32Array(256) };
          zoneMap.set(zr.zoneIndex, row);
        }
        row.inside += zr.inside;
        row.valid += zr.valid;
        row.changed += zr.changed;
        for (let code = 0; code < 256; code++) {
          if (zr.classCounts[code]) row.classCounts[code] += zr.classCounts[code];
        }
      }
    }
    const gap = block.metadata.gapFill;
    if (gap) {
      for (const side of gap.sides) gapSides.add(side);
      gapWindow = Math.max(gapWindow, gap.windowDays);
      gapWeighted += gap.filledPct * c.inside;
      gapWeight += c.inside;
    }
  }

  const validPct = inside === 0 ? 0 : (valid / inside) * 100;
  const classes = CLASS_DEFS.map((def) => {
    const pixels = counts[def.code];
    return {
      code: def.code,
      label: def.label,
      color: def.color,
      pixels,
      areaHa: pixels * pxAreaHa,
      areaKm2: (pixels * pxAreaHa) / 10_000,
      pctOfValid:
        def.code === CLASS.masked || valid === 0 ? 0 : (pixels / valid) * 100,
    };
  });

  const tehsils: TehsilZonalStat[] | null = args.zones
    ? Array.from(zoneMap.entries())
        .map(([z, row]) => {
          const pixelsByClass: Record<number, number> = {};
          for (let code = CLASS.vegGain; code <= CLASS.waterLoss; code++) {
            if (row.classCounts[code] > 0) pixelsByClass[code] = row.classCounts[code];
          }
          return {
            tehsilId: args.zones?.[z - 1]?.id ?? String(z),
            name: args.zones?.[z - 1]?.name ?? `Zone ${z}`,
            pixelsByClass,
            changedHa: row.changed * pxAreaHa,
            validPixels: row.valid,
            insidePixels: row.inside,
          };
        })
        .filter((row) => row.insidePixels > 0)
    : null;

  const hotspots: Hotspot[] = args.events.features.slice(0, 10).map((feature) => {
    const props = propsOf(feature);
    const classCode = Number(props.classCode);
    return {
      centroid: props.centroid as [number, number],
      bbox: props.bbox as [number, number, number, number],
      areaHa: Number(props.areaHa ?? 0),
      classCode,
      classLabel: String(props.classLabel ?? classLabel(classCode)),
      tehsilName: typeof props.tehsilName === "string" ? props.tehsilName : null,
      polygon: feature.geometry as GeoJSON.MultiPolygon,
      ...(props.confidence ? { confidence: props.confidence as ConfidenceTier } : {}),
      ...(props.confidencePct !== undefined
        ? { confidencePct: Number(props.confidencePct) }
        : {}),
      ...(props.subLabel !== undefined ? { subLabel: props.subLabel as string | null } : {}),
      ...(Array.isArray(props.tags) ? { tags: props.tags as string[] } : {}),
      ...(props.edge === true ? { edge: true } : {}),
    };
  });

  let eventsEdgeTotal = 0;
  const byClass = new Map<number, { classCode: number; count: number; edgeCount: number }>();
  for (const feature of args.events.features) {
    const props = propsOf(feature);
    const code = Number(props.classCode);
    const isEdge = props.edge === true;
    if (isEdge) eventsEdgeTotal += 1;
    let row = byClass.get(code);
    if (!row) {
      row = { classCode: code, count: 0, edgeCount: 0 };
      byClass.set(code, row);
    }
    row.count += 1;
    if (isEdge) row.edgeCount += 1;
  }

  const metadata: CompareMetadata = {
    ...args.metadataTemplate,
    width: grid.width,
    height: grid.height,
    metersPerPixel: grid.metersPerPixel,
    coarse: grid.metersPerPixel > 10,
    detail: args.detail,
    estimatedPu: args.estimatedPu,
    // Block-scope diagnostics don't describe the whole AOI — omit them.
    diagnostics: undefined,
    ...(gapWeight > 0 && gapSides.size > 0
      ? {
          gapFill: {
            windowDays: gapWindow,
            sides: Array.from(gapSides).sort(),
            filledPct: Math.round((gapWeighted / gapWeight) * 10) / 10,
          },
        }
      : {}),
    generatedAt: new Date().toISOString(),
  };

  return {
    metadata,
    classes,
    validPct,
    areaHa: inside * pxAreaHa,
    validHa: valid * pxAreaHa,
    changedHa: changed * pxAreaHa,
    tehsils,
    hotspots,
    changeBbox:
      minCol >= 0
        ? [
            grid.bbox[0] + minCol * grid.pxLon,
            grid.bbox[3] - (maxRow + 1) * grid.pxLat,
            grid.bbox[0] + (maxCol + 1) * grid.pxLon,
            grid.bbox[3] - minRow * grid.pxLat,
          ]
        : null,
    negligible: changed === 0,
    ...(confidence ? { confidence } : {}),
    edgeHa: edgeChanged * pxAreaHa,
    eventsTotal: args.events.features.length,
    eventsEdgeTotal,
    eventsByClass: Array.from(byClass.values()).sort((a, b) => a.classCode - b.classCode),
  };
}

/* ------------------------------------------------------------------ */
/* Preview (≤COMPARE_MAX_PX) assembled from the blocks                 */
/* ------------------------------------------------------------------ */

function assemblePreview(
  plan: DetailPlan,
  blocks: CompareBlockEntry[],
  maxPx: number,
): Pick<
  CompareArtifactEntry,
  "overlayPng" | "classGz" | "coverageGz" | "sourceGz" | "magnitudeGz" | "width" | "height"
> {
  const grid = plan.grid;
  const native = Math.max(GRID_MIN_PX, Math.floor(nativeLongSidePx(grid.bbox)));
  const { width, height } = computeOutputSize(grid.bbox, Math.min(maxPx, native));
  const n = width * height;
  const classPrev = new Uint8Array(n);
  const coveragePrev = new Uint8Array(n);
  const sourcePrev = new Uint8Array(n);
  const ndviPrev = new Int8Array(n);
  const mndwiPrev = new Int8Array(n);
  const ndbiPrev = new Int8Array(n);
  const combinedPrev = new Int8Array(n);

  for (const block of blocks) {
    const cls = inflateU8(block.classGz);
    const cov = inflateU8(block.coverageGz);
    const src = inflateU8(block.sourceGz);
    const ndvi = inflateI8(block.magnitudeGz.ndvi);
    const mndwi = inflateI8(block.magnitudeGz.mndwi);
    const ndbi = inflateI8(block.magnitudeGz.ndbi);
    const combined = inflateI8(block.magnitudeGz.combined);
    const [cx0, cy0, cx1, cy1] = block.core;
    const [ex0, ey0] = block.expanded;
    const bw = block.width;
    const sx0 = Math.max(0, Math.floor((cx0 / grid.width) * width));
    const sx1 = Math.min(width, Math.ceil((cx1 / grid.width) * width));
    const sy0 = Math.max(0, Math.floor((cy0 / grid.height) * height));
    const sy1 = Math.min(height, Math.ceil((cy1 / grid.height) * height));
    for (let sy = sy0; sy < sy1; sy++) {
      for (let sx = sx0; sx < sx1; sx++) {
        const col = Math.floor((sx / width) * grid.width);
        const row = Math.floor((sy / height) * grid.height);
        // Owner check — this preview pixel maps into this block's core.
        const i = Math.floor(col / plan.blockPx);
        const j = Math.floor(row / plan.blockPx);
        if (i + j * plan.cols !== block.index) continue;
        const li = (row - ey0) * bw + (col - ex0);
        const pi = sy * width + sx;
        classPrev[pi] = cls[li];
        coveragePrev[pi] = cov[li];
        sourcePrev[pi] = src[li];
        ndviPrev[pi] = ndvi[li];
        mndwiPrev[pi] = mndwi[li];
        ndbiPrev[pi] = ndbi[li];
        combinedPrev[pi] = combined[li];
      }
    }
  }

  return {
    overlayPng: encodePng(classToRgba(classPrev, width), width, height),
    classGz: deflateSync(classPrev),
    coverageGz: deflateSync(coveragePrev),
    sourceGz: deflateSync(sourcePrev),
    magnitudeGz: {
      ndvi: deflateSync(ndviPrev),
      mndwi: deflateSync(mndwiPrev),
      ndbi: deflateSync(ndbiPrev),
      combined: deflateSync(combinedPrev),
    },
    width,
    height,
  };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/** Rect overlap test on AOI-grid px rectangles (half-open). */
function rectsOverlap(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return Math.max(a[0], b[0]) < Math.min(a[2], b[2]) && Math.max(a[1], b[1]) < Math.min(a[3], b[3]);
}

/** Cache-first detailed run with stateless recompute on a miss. */
export async function ensureDetail(
  resolved: ResolvedCompareParams,
  options: EnsureDetailOptions = {},
): Promise<{ entry: CompareArtifactEntry; hit: boolean }> {
  const env = getServerEnv();
  const { value, hit } = await ensureCached(
    detailResultCache,
    resolved.key,
    async (): Promise<CompareArtifactEntry> => {
      const hits = options.sceneHits ?? (await validateScenes(resolved));
      const plan = planDetail(resolved.area.bbox);
      if (plan.blocks.length > env.COMPARE_MAX_BLOCKS) {
        throw apiError(
          413,
          "DETAIL_TOO_MANY_BLOCKS",
          `This area needs ${plan.blocks.length} detailed blocks (cap ${env.COMPARE_MAX_BLOCKS}). ` +
            `Run Smart detail (only hot blocks are refined) or pick a smaller area.`,
        );
      }

      let selected: Set<number>;
      let screeningPu = 0;
      let screeningMeta: CompareMetadata | null = null;
      if (resolved.detail === "smart") {
        options.onProgress?.({ stage: "screen" });
        const screening = await ensureScreening(resolved, hits);
        screeningPu = screening.estimatedPu;
        screeningMeta = screening.metadata;
        const ratio = combinedRatio(
          inflateI8(screening.magnitudeGz.combined),
          inflateU8(screening.classGz),
        );
        selected = screenDetailBlocks(plan, {
          width: screening.width,
          height: screening.height,
          ratio,
        });
      } else {
        selected = new Set(plan.blocks.map((block) => block.index));
      }
      const chosen = plan.blocks.filter((block) => selected.has(block.index));

      const blocksOut: CompareBlockEntry[] = [];
      const unions: Array<[number, number]> = [];
      let runIndex = 0;
      for (const block of chosen) {
        if (options.signal?.aborted) throw abortError();
        runIndex += 1;
        options.onProgress?.({ stage: "block", index: runIndex, total: chosen.length });
        const entry = await ensureDetailBlock(resolved, block, hits);
        blocksOut.push(entry);
        // Seam unions against the already-processed neighbours (each pair
        // exactly once; transitivity comes from unionRoots at merge time).
        const current: DetailBlockRaster = {
          index: block.index,
          originX: block.expanded[0],
          originY: block.expanded[1],
          width: block.width,
          height: block.height,
          labels: inflateI32(entry.labelsGz),
        };
        for (const prev of blocksOut.slice(0, -1)) {
          if (!rectsOverlap(prev.expanded, block.expanded)) continue;
          const prevRaster: DetailBlockRaster = {
            index: prev.index,
            originX: prev.expanded[0],
            originY: prev.expanded[1],
            width: prev.width,
            height: prev.height,
            labels: inflateI32(prev.labelsGz),
          };
          unions.push(...seamUnionPairs([prevRaster, current]));
        }
      }
      options.onProgress?.({ stage: "analyze" });

      const events = mergeDetailEvents(blocksOut, plan, unions);
      const blocksPu = blocksOut.reduce((sum, block) => sum + block.estimatedPu, 0);
      const estimatedPu = Math.round((screeningPu + blocksPu) * 100) / 100;
      const zones = districtZones(resolved.area);
      const stats = buildMergedStats({
        plan,
        blocks: blocksOut,
        events,
        // Smart screening can legitimately select zero blocks (nothing hot)
        // — the screening metadata then templates the merged stats.
        metadataTemplate:
          blocksOut[0]?.metadata ??
          screeningMeta ??
          (await ensureDetailBlock(resolved, plan.blocks[0], hits)).metadata,
        zones: zones ?? null,
        detail: resolved.detail === "smart" ? "smart" : "detailed",
        estimatedPu,
      });
      const preview = assemblePreview(plan, blocksOut, resolved.maxPx);

      const entry: CompareArtifactEntry = {
        stats,
        ...preview,
        bbox: [plan.grid.bbox[0], plan.grid.bbox[1], plan.grid.bbox[2], plan.grid.bbox[3]],
        geometry: resolved.area.geometry,
        events,
        detail: {
          mode: resolved.detail === "smart" ? "smart" : "detailed",
          grid: {
            width: plan.grid.width,
            height: plan.grid.height,
            bbox: [plan.grid.bbox[0], plan.grid.bbox[1], plan.grid.bbox[2], plan.grid.bbox[3]],
            pxLon: plan.grid.pxLon,
            pxLat: plan.grid.pxLat,
          },
          cols: plan.cols,
          rows: plan.rows,
          blockPx: plan.blockPx,
          overlapPx: plan.overlapPx,
          blocks: blocksOut.map((block) => ({
            index: block.index,
            i: plan.blocks[block.index].i,
            j: plan.blocks[block.index].j,
            core: block.core,
            expanded: block.expanded,
            bbox: block.bbox,
            width: block.width,
            height: block.height,
          })),
          unions,
          blocksTotal: plan.blocks.length,
          estimatedPu,
        },
      };
      return entry;
    },
    { inflight: inflightDetail, ttlSeconds: env.IMAGERY_CACHE_TTL_SECONDS },
  );
  return { entry: value, hit };
}

/** Estimate card for the confirm dialog (no quota consumed). */
export async function estimateDetail(resolved: ResolvedCompareParams): Promise<DetailEstimate> {
  const env = getServerEnv();
  const plan = planDetail(resolved.area.bbox);
  if (plan.blocks.length > env.COMPARE_MAX_BLOCKS) {
    throw apiError(
      413,
      "DETAIL_TOO_MANY_BLOCKS",
      `This area needs ${plan.blocks.length} detailed blocks (cap ${env.COMPARE_MAX_BLOCKS}). ` +
        `Run Smart detail (only hot blocks are refined) or pick a smaller area.`,
    );
  }
  let screeningPu = 0;
  let chosen: DetailBlock[];
  if (resolved.detail === "smart") {
    const screening = await ensureScreening(resolved);
    screeningPu = screening.estimatedPu;
    const ratio = combinedRatio(
      inflateI8(screening.magnitudeGz.combined),
      inflateU8(screening.classGz),
    );
    const selected = screenDetailBlocks(plan, {
      width: screening.width,
      height: screening.height,
      ratio,
    });
    chosen = plan.blocks.filter((block) => selected.has(block.index));
  } else {
    chosen = plan.blocks;
  }
  const evidencePlan = evidencePlanFor(resolved);
  const blocksPu = Math.round(
    chosen.reduce(
      (sum, block) =>
        sum +
        analysisPu({
          width: block.width,
          height: block.height,
          engine: resolved.engine,
          inputMode: resolved.inputMode,
          compositeWindowDays: resolved.compositeWindowDays,
          evidencePlan,
        }),
      0,
    ) * 100,
  ) / 100;
  const estimatedPu = Math.round((screeningPu + blocksPu) * 100) / 100;
  return {
    detail: resolved.detail === "smart" ? "smart" : "detailed",
    blocksTotal: plan.blocks.length,
    blocksSelected: chosen.length,
    screeningPu,
    blocksPu,
    estimatedPu,
    cap: env.COMPARE_MAX_BLOCKS,
    overQuickLimit: estimatedPu > env.PER_ANALYSIS_PU_LIMIT,
  };
}

/* ------------------------------------------------------------------ */
/* XYZ tile assembly                                                   */
/* ------------------------------------------------------------------ */

/** Tile edge (px) — matches the imagery tile route's 512 standard. */
const DETAIL_TILE_PX = 512;

/**
 * Assembles one native-resolution tile from the cached blocks. Skipped
 * (smart-screened) blocks render as analysed-unchanged. Returns null when
 * the tile misses the AOI.
 */
export async function detailTilePng(
  resolved: ResolvedCompareParams,
  entry: CompareArtifactEntry,
  request: DetailTileRequest,
): Promise<Buffer | null> {
  const meta = entry.detail;
  if (!meta) return null;
  const grid: AnalysisGrid = makeAnalysisGrid(
    meta.grid.bbox,
    meta.grid.width,
    meta.grid.height,
  );
  const rect = tilePxRect(grid, request.z, request.x, request.y);
  if (!rect) return null;

  const spanCols = Math.max(1, rect.col1 - rect.col0);
  const spanRows = Math.max(1, rect.row1 - rect.row0);
  const n = DETAIL_TILE_PX * DETAIL_TILE_PX;
  const cls = new Uint8Array(n);
  const coverage = new Uint8Array(n);
  const source = new Uint8Array(n);
  const plane = new Int8Array(n);

  const blocksByIndex = new Map(meta.blocks.map((block) => [block.index, block]));
  const inflated = new Map<
    number,
    {
      cls: Uint8Array;
      coverage: Uint8Array;
      source: Uint8Array;
      plane: Int8Array;
    }
  >();
  const blockPx = meta.blockPx;
  const cols = meta.cols;

  for (let ty = 0; ty < DETAIL_TILE_PX; ty++) {
    const row = rect.row0 + Math.floor((ty * spanRows) / DETAIL_TILE_PX);
    if (row >= rect.row1) continue;
    const j = Math.floor(row / blockPx);
    for (let tx = 0; tx < DETAIL_TILE_PX; tx++) {
      const col = rect.col0 + Math.floor((tx * spanCols) / DETAIL_TILE_PX);
      if (col >= rect.col1) continue;
      const i = Math.floor(col / blockPx);
      const blockMeta = blocksByIndex.get(j * cols + i);
      if (!blockMeta) continue; // smart-skipped → analysed-unchanged defaults
      let arrays = inflated.get(blockMeta.index);
      if (!arrays) {
        const blockEntry = await ensureDetailBlock(resolved, blockMeta);
        arrays = {
          cls: inflateU8(blockEntry.classGz),
          coverage: inflateU8(blockEntry.coverageGz),
          source: inflateU8(blockEntry.sourceGz),
          plane: inflateI8(
            request.layer === "magnitude" ? blockEntry.magnitudeGz[request.index] : blockEntry.magnitudeGz.combined,
          ),
        };
        inflated.set(blockMeta.index, arrays);
      }
      const [ex0, ey0] = blockMeta.expanded;
      const li = (row - ey0) * blockMeta.width + (col - ex0);
      const pi = ty * DETAIL_TILE_PX + tx;
      cls[pi] = arrays.cls[li];
      coverage[pi] = arrays.coverage[li];
      source[pi] = arrays.source[li];
      plane[pi] = arrays.plane[li];
    }
  }

  let rgba: Uint8Array;
  switch (request.layer) {
    case "coverage":
      rgba = coverageToRgba(coverage);
      break;
    case "gapfill":
      rgba = gapFillToRgba(source, cls, DETAIL_TILE_PX);
      break;
    case "magnitude":
      rgba = magnitudeToRgba(
        plane,
        cls,
        DETAIL_TILE_PX,
        request.index === "combined" ? "combined" : "signed",
      );
      break;
    default: {
      rgba = classToRgba(cls, DETAIL_TILE_PX, { showUnchanged: request.showUnchanged });
      if (request.hideCodes && request.hideCodes.length > 0) {
        const hidden = new Set(request.hideCodes);
        for (let i = 0; i < n; i++) {
          if (hidden.has(cls[i])) rgba[i * 4 + 3] = 0;
        }
      }
      break;
    }
  }
  return encodePng(rgba, DETAIL_TILE_PX, DETAIL_TILE_PX);
}
