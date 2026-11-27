import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Relative import: the test harness compiles this file with commonjs where
// the "@/lib/…" alias does not resolve.
import { sharedInstance } from "./singleton";

/**
 * Small cache abstraction for rendered imagery tiles/images.
 * The in-memory LRU is the only implementation for now; the interface is
 * ready for a Supabase Storage-backed implementation later.
 */
export interface BlobCache {
  get(key: string): Buffer | undefined;
  set(key: string, value: Buffer, ttlSeconds: number): void;
}

interface CacheEntry {
  buffer: Buffer;
  expiresAt: number;
}

export class MemoryLruCache implements BlobCache {
  private store = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = 64) {}

  get(key: string): Buffer | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh LRU order.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.buffer;
  }

  set(key: string, value: Buffer, ttlSeconds: number): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { buffer: value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Drops every entry (test harness only). */
  clear(): void {
    this.store.clear();
  }
}

/**
 * Process-wide cache instances (lib/singleton.ts): `next dev` evaluates each
 * route from its own module graph, so plain module-level caches fork per route
 * (overlay/events would miss entries the analyze route just wrote — seen
 * live), and Vercel bundles each route into its own process. globalThis is
 * shared across those compilations; production behaviour is unchanged.
 */

export const imageryCache: BlobCache = sharedInstance("rse.imageryCache", () => new MemoryLruCache(64));
/** Larger LRU for 512px tiles (a single pan/zoom can touch hundreds). */
export const tileCache: BlobCache = sharedInstance("rse.tileCache", () => new MemoryLruCache(512));

// ------------------------------------------------- change detection (compare)

/** Bump when the analysis pipeline/class codes change (invalidates stored artifacts). */
export const COMPARE_VERSION = "v2";

/** One cached comparison run: stats JSON + PNG overlay + deflated class raster. */
export interface CompareArtifactEntry {
  stats: import("@/lib/analysis/types").CompareStats;
  overlayPng: Buffer;
  /** Deflated raw class grid (inflate → encodeClassGeoTiff on export). */
  classGz: Buffer;
  /** Phase 1: deflated per-pixel coverage-reason raster (COVERAGE_REASON codes). */
  coverageGz: Buffer;
  /** Phase 1: deflated gap-fill source flags (1 = value from the rescue window). */
  sourceGz: Buffer;
  /** Phase 1: deflated int8 Δ-index magnitude planes (MAGNITUDE_SCALE quantised). */
  magnitudeGz: { ndvi: Buffer; mndwi: Buffer; ndbi: Buffer; combined: Buffer };
  width: number;
  height: number;
  bbox: [number, number, number, number];
  /** Clip geometry of the analysed area — lets the summary route re-render previews. */
  geometry: import("@/lib/cdse/geometry").ClipGeometry;
  /** Full-coverage change events (patch vectors with stable ids, Phase 6 #13/#16). */
  events: GeoJSON.FeatureCollection;
  /** Phase 3: present on detailed/smart runs — block lattice + seam unions
   *  behind the XYZ tile route (the raster fields above are the ≤1500 px
   *  downsampled preview assembled from the blocks). */
  detail?: CompareDetailMeta;
}

/** Serialisable block-lattice metadata carried by a detailed entry. */
export interface CompareDetailMeta {
  mode: "detailed" | "smart";
  /** Full native AOI grid the blocks tile (tiles map through this). */
  grid: {
    width: number;
    height: number;
    bbox: [number, number, number, number];
    pxLon: number;
    pxLat: number;
  };
  cols: number;
  rows: number;
  blockPx: number;
  overlapPx: number;
  blocks: Array<{
    index: number;
    i: number;
    j: number;
    core: [number, number, number, number];
    expanded: [number, number, number, number];
    bbox: [number, number, number, number];
    width: number;
    height: number;
  }>;
  /** Union-find seam pairs over (blockIndex·stride + label) ids. */
  unions: Array<[number, number]>;
  /** Lattice total before smart selection (blocks.length ≤ blocksTotal). */
  blocksTotal: number;
  /** Estimated PU of the whole detailed run (screening + selected blocks). */
  estimatedPu: number;
}

/** One classified detail block (deflated planes + core-scope counts). */
export interface CompareBlockEntry {
  index: number;
  /** Owned region in AOI-grid px (disjoint, full cover). */
  core: [number, number, number, number];
  /** Fetched region (core ± overlap, clamped). */
  expanded: [number, number, number, number];
  bbox: [number, number, number, number];
  width: number;
  height: number;
  classGz: Buffer;
  coverageGz: Buffer;
  sourceGz: Buffer;
  magnitudeGz: { ndvi: Buffer; mndwi: Buffer; ndbi: Buffer; combined: Buffer };
  /** Deflated Int32 patch labels of the expanded region (seam merge). */
  labelsGz: Buffer;
  /** Block-local patch vectors (GeoJSON) — merged into the entry events. */
  events: GeoJSON.FeatureCollection;
  /** Owned-pixel counts (never double-counted across blocks). */
  counts: {
    /** Indexed by class code (0…6; 255 unused). */
    classCounts: number[];
    inside: number;
    valid: number;
    changed: number;
    edgeChanged: number;
    /** Changed-pixel extent in AOI-grid px (minCol, minRow, maxCol, maxRow). */
    changedExtent: [number, number, number, number] | null;
    confidence: { high: number; medium: number; low: number } | null;
    zones: Array<{
      zoneIndex: number;
      inside: number;
      valid: number;
      changed: number;
      classCounts: number[];
    }> | null;
  };
  /** Block metadata (identical inputs across blocks — merged template). */
  metadata: import("@/lib/analysis/types").CompareMetadata;
  estimatedPu: number;
}

/** Coarse screening pass for smart mode (magnitude + class mask). */
export interface CompareScreenEntry {
  width: number;
  height: number;
  magnitudeGz: { ndvi: Buffer; mndwi: Buffer; ndbi: Buffer; combined: Buffer };
  /** Deflated uint8 class grid (outside/masked suppression for screening). */
  classGz: Buffer;
  /** Screening metadata — the merged-stats template when smart selects no
   *  blocks (identical inputs, block-scoped fields get overridden). */
  metadata: import("@/lib/analysis/types").CompareMetadata;
  estimatedPu: number;
}

/** Generic TTL + LRU eviction for non-binary entries. */
export class MemoryObjectLru<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  constructor(private readonly maxEntries = 8) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlSeconds: number): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Drops every entry (test harness only). */
  clear(): void {
    this.store.clear();
  }
}

/** Small LRU: each entry is a full analysis (PNG ~ hundreds of KB). */
export const compareResultCache = sharedInstance(
  "rse.compareResultCache",
  () => new MemoryObjectLru<CompareArtifactEntry>(6),
);
/** Phase 3: completed detailed runs (same entry shape + detail metadata). */
export const detailResultCache = sharedInstance(
  "rse.detailResultCache",
  () => new MemoryObjectLru<CompareArtifactEntry>(4),
);
/** Phase 3: per-block artifacts — tiles inflate these on demand (memory half
 *  of the block cache; disk persistence lives beside the tile cache). */
export const detailBlockCache = sharedInstance(
  "rse.detailBlockCache",
  () => new MemoryObjectLru<CompareBlockEntry>(48),
);
/** Phase 3: smart-mode screening pass (one per analysis key). */
export const detailScreenCache = sharedInstance(
  "rse.detailScreenCache",
  () => new MemoryObjectLru<CompareScreenEntry>(4),
);
/** Phase-thresholds: derived per-date index grids — keyed WITHOUT thresholds
 *  (area, dates, grid, gap-fill settings) so preset/threshold re-runs
 *  re-classify from it with zero Process API calls. Each entry is ~100-170 MB
 *  of typed arrays at the 1500 px cap, so exactly one analysis is held. */
export const indexRasterCache = sharedInstance(
  "rse.indexRasterCache",
  () => new MemoryObjectLru<import("@/lib/analysis/process").DerivedIndexGrids>(1),
);
/** Phase 3: encoded detail tiles (512² PNG per key × layer × zoom × xy). */
export const detailTileCache = sharedInstance(
  "rse.detailTileCache",
  () => new MemoryObjectLru<Buffer>(64),
);
/** Phase 4: probe verdicts — point-keyed (rounded ~100 m), cheap repeat clicks. */
export const probeCache = sharedInstance(
  "rse.probeCache",
  () => new MemoryObjectLru<import("@/lib/analysis/probe").ProbeResult>(32),
);
export function probeCacheKey(key: string, lng: number, lat: number): string {
  return `${key}|probe|${lng.toFixed(3)},${lat.toFixed(3)}`;
}
/** Derived overlay-layer PNGs (coverage/magnitude/gap-fill/show-unchanged) —
 *  encoded per request, so cache the encode per key × layer × variant. */
export const overlayLayerCache = sharedInstance(
  "rse.overlayLayerCache",
  () => new MemoryObjectLru<Buffer>(16),
);
/** Gemini summary text, keyed by prompt hash (stats numbers → text, 30 min TTL). */
export const aiSummaryCache: BlobCache = sharedInstance("rse.aiSummaryCache", () => new MemoryLruCache(64));

/**
 * Bump whenever evalscripts or render settings change so previously cached
 * PNGs (produced by different code) are not served.
 */
export const RENDER_VERSION = "v5-bicubic-z15";

export function imageryCacheKey(input: {
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  date: string;
  composite: string;
  size: number;
  format?: "png" | "tiff" | "analysis";
}): string {
  const payload = JSON.stringify([
    RENDER_VERSION,
    input.geometry,
    input.date,
    input.composite,
    input.size,
    input.format ?? "png",
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/** Cache key for one XYZ tile of one area/day/composite. */
export function tileCacheKey(input: {
  areaId: string;
  level: string;
  date: string;
  composite: string;
  z: number;
  x: number;
  y: number;
}): string {
  const payload = JSON.stringify([
    RENDER_VERSION,
    input.areaId,
    input.level,
    input.date,
    input.composite,
    input.z,
    input.x,
    input.y,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/** Cache key for one comparison run (area × dates × sensitivity × MMU × engine × input
 *  × rules × evidence flags — Phase 3 fused runs must never hit a legacy entry). */
export function compareCacheKey(input: {
  areaId: string;
  level: string;
  dateA: string;
  dateB: string;
  sensitivity: string;
  minPatchHa: number;
  /** Phase 2 despeckle mode (gentle | legacy). */
  speckle?: string;
  engine: string;
  inputMode: string;
  compositeWindowDays: number;
  /** CHANGE_RULES ("legacy" | "fused"). */
  rules?: string;
  /** S1 window in days (0 = SAR off) — affects fused results. */
  s1WindowDays?: number;
  /** WorldCover prior on/off — affects fused results. */
  worldCover?: number;
  /** SHARPEN_SWIR (1/0) — regression SWIR sharpening changes NDBI/MNDWI/BSI. */
  sharpen?: number;
  /** Phase 3 detail mode. "quick" (and absent) keep the legacy key shape so
   *  pre-Phase-3 cache entries stay valid. */
  detail?: string;
  /** Phase-thresholds: SSO per-run overrides — Custom runs fork the
   *  CLASSIFIED-result key; the derived-raster cache key never sees them. */
  thresholds?: Record<string, number>;
}): string {
  const payload = JSON.stringify([
    COMPARE_VERSION,
    input.areaId,
    input.level,
    input.dateA,
    input.dateB,
    input.sensitivity,
    input.minPatchHa,
    input.speckle ?? "gentle",
    input.engine,
    input.inputMode,
    input.compositeWindowDays,
    input.rules ?? "legacy",
    input.s1WindowDays ?? 0,
    input.worldCover ?? 0,
    input.sharpen ?? 0,
    ...(input.detail && input.detail !== "quick" ? [input.detail] : []),
    ...(input.thresholds && Object.keys(input.thresholds).length > 0
      ? [input.thresholds]
      : []),
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/** Key helpers for the Phase 3 detail caches (derived from the base key). */
export function detailScreenKey(key: string): string {
  return `${key}|screen`;
}
export function detailBlockKey(key: string, index: number): string {
  return `${key}|b${index}`;
}
export function detailTileKey(
  key: string,
  layer: string,
  index: string,
  z: number,
  x: number,
  y: number,
  showUnchanged: boolean,
): string {
  return `${key}|${layer}|${index}|${z}/${x}/${y}|${showUnchanged ? 1 : 0}`;
}

/** Cache key for one AI summary request (analysis × language × imagery choice). */
export function summaryCacheKey(input: {
  analysisKey: string;
  language: "en" | "hi";
  includeImages: boolean;
}): string {
  const payload = `${input.analysisKey}|${input.language}|${input.includeImages ? 1 : 0}`;
  return createHash("sha256").update(payload).digest("hex");
}

// ------------------------------------------------- fields (cropping pattern)

/** Bump when the field extraction pipeline changes (zoom, merge, caps, ids). */
export const FIELDS_VERSION = "v1";
/** Raw field entries are expensive (tile + COG reads) — keep them a week. */
export const FIELDS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** One built field selection: bbox+year keyed, before per-request thresholds. */
export type FieldsRawEntry = import("@/lib/fields/query").FieldsRawEntry;

/** Small LRU: each entry is a whole selection (up to 12k features). */
export const fieldsCache = sharedInstance(
  "rse.fieldsCache",
  () => new MemoryObjectLru<FieldsRawEntry>(4),
);

/** Cache key for one built field selection — bbox rounded to 6 dp. */
export function fieldsCacheKey(input: { bbox: [number, number, number, number]; year: number }): string {
  const payload = JSON.stringify([
    FIELDS_VERSION,
    input.bbox.map((value) => Math.round(value * 1e6) / 1e6),
    input.year,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/** Bump when the pattern rules/calendar/stream frames change (invalidates stored results). */
export const PATTERN_VERSION = "v1";

/** One finished pattern run: the full NDJSON result (12 curves per field). */
export type PatternResult = import("@/lib/fields/patternRun").PatternResult;

/** Small LRU: each entry is a whole 12-month run (up to 3000 curves). */
export const patternCache = sharedInstance(
  "rse.patternCache",
  () => new MemoryObjectLru<PatternResult>(4),
);

/** Cache key for one pattern run — bbox rounded to 6 dp, thresholds included. */
export function patternCacheKey(input: {
  bbox: [number, number, number, number];
  year: number;
  minConfidence: number;
  grouping: boolean;
  maxCount: number;
}): string {
  const payload = JSON.stringify([
    FIELDS_VERSION,
    PATTERN_VERSION,
    input.bbox.map((value) => Math.round(value * 1e6) / 1e6),
    input.year,
    input.minConfidence,
    input.grouping ? 1 : 0,
    input.maxCount,
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

// ------------------------------------------------------------- disk cache

/**
 * Optional on-disk tile cache (TILE_CACHE_DIR). Best-effort and synchronous —
 * failures never break a tile response; the memory LRU always answers first.
 * Disabled on Vercel (serverless instances have ephemeral, size-limited disks).
 */
export function diskCacheGet(key: string, dir?: string): Buffer | undefined {
  if (!dir || process.env.VERCEL) return undefined;
  try {
    return readFileSync(join(dir, `${key}.png`));
  } catch {
    return undefined;
  }
}

export function diskCacheSet(key: string, value: Buffer, dir?: string): void {
  if (!dir || process.env.VERCEL) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${key}.png`), value);
  } catch {
    // disk cache is best-effort
  }
}
