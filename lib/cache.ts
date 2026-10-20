import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
}

export const imageryCache: BlobCache = new MemoryLruCache(64);
/** Larger LRU for 512px tiles (a single pan/zoom can touch hundreds). */
export const tileCache: BlobCache = new MemoryLruCache(512);

/**
 * Bump whenever evalscripts or render settings change so previously cached
 * PNGs (produced by different code) are not served.
 */
export const RENDER_VERSION = "v4-visual-dn";

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
