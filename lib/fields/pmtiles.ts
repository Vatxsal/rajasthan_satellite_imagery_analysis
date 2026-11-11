/**
 * Minimal PMTiles v3 reader over an injected HTTP-range reader — enough to
 * address single tiles inside the 3.3 GB Fields of the World IN_RJ archive
 * without shipping a client dependency (the `pmtiles` package is >200 KB over
 * our dependency budget).
 *
 * Header layout, directory serialization and Hilbert tile ids follow the
 * reference implementation (protomaps/PMTiles, BSD) and the PMTiles v3 spec.
 */
import { gunzipSync } from "node:zlib";
import { readVarint, type BufferPosition } from "./bytes";

/** Reads `length` bytes starting at `offset` or throws (network/HTTP failure). */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

export const HEADER_SIZE = 127;

/** PMTiles v3 directory entry (tile data or a nested leaf directory). */
export interface DirectoryEntry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

export interface PmtilesHeader {
  specVersion: number;
  rootDirectoryOffset: number;
  rootDirectoryLength: number;
  leafDirectoryOffset: number;
  tileDataOffset: number;
  internalCompression: number;
  tileCompression: number;
  minZoom: number;
  maxZoom: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;

function getUint64(view: DataView, offset: number): number {
  const high = view.getUint32(offset + 4, true);
  const low = view.getUint32(offset + 0, true);
  return high * 2 ** 32 + low;
}

/** Parses the fixed 127-byte PMTiles v3 header (magic + spec check). */
export function parseHeader(bytes: Uint8Array): PmtilesHeader {
  if (bytes.byteLength < HEADER_SIZE) {
    throw new Error(`PMTiles header truncated (${bytes.byteLength} bytes, expected ${HEADER_SIZE})`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // "PM" magic — rejects any non-PMTiles payload a proxy might hand back.
  if (view.getUint16(0, true) !== 0x4d50) {
    throw new Error("Not a PMTiles archive (bad magic)");
  }
  const specVersion = view.getUint8(7);
  if (specVersion !== 3) {
    throw new Error(`PMTiles spec version ${specVersion} is not supported (expected 3)`);
  }
  return {
    specVersion,
    rootDirectoryOffset: getUint64(view, 8),
    rootDirectoryLength: getUint64(view, 16),
    leafDirectoryOffset: getUint64(view, 40),
    tileDataOffset: getUint64(view, 56),
    internalCompression: view.getUint8(97),
    tileCompression: view.getUint8(98),
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101),
    minLon: view.getInt32(102, true) / 10_000_000,
    minLat: view.getInt32(106, true) / 10_000_000,
    maxLon: view.getInt32(110, true) / 10_000_000,
    maxLat: view.getInt32(114, true) / 10_000_000,
  };
}

/** Decodes a gzip/none-compressed directory blob into sorted entries. */
export function deserializeDirectory(bytes: Uint8Array, compression: number): DirectoryEntry[] {
  let buffer = bytes;
  if (compression === COMPRESSION_GZIP) {
    buffer = gunzipSync(bytes);
  } else if (compression !== COMPRESSION_NONE) {
    throw new Error(`Unsupported PMTiles compression ${compression}`);
  }
  const p: BufferPosition = { buf: buffer, pos: 0 };
  const numEntries = readVarint(p);
  const entries: DirectoryEntry[] = [];

  let lastId = 0;
  for (let i = 0; i < numEntries; i++) {
    const delta = readVarint(p);
    entries.push({ tileId: lastId + delta, offset: 0, length: 0, runLength: 1 });
    lastId += delta;
  }
  for (let i = 0; i < numEntries; i++) entries[i].runLength = readVarint(p);
  for (let i = 0; i < numEntries; i++) entries[i].length = readVarint(p);
  for (let i = 0; i < numEntries; i++) {
    const delta = readVarint(p);
    if (delta === 0 && i > 0) {
      entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    } else {
      entries[i].offset = delta - 1;
    }
  }
  return entries;
}

/**
 * Binary search for a tile id. A miss falls back to the previous entry when
 * it is a leaf pointer (runLength 0) or a run covering the id (spec §3).
 */
export function findTile(entries: DirectoryEntry[], tileId: number): DirectoryEntry | null {
  let m = 0;
  let n = entries.length - 1;
  while (m <= n) {
    const k = (n + m) >> 1;
    const cmp = tileId - entries[k].tileId;
    if (cmp > 0) {
      m = k + 1;
    } else if (cmp < 0) {
      n = k - 1;
    } else {
      return entries[k];
    }
  }
  if (n >= 0) {
    if (entries[n].runLength === 0) return entries[n];
    if (tileId - entries[n].tileId < entries[n].runLength) return entries[n];
  }
  return null;
}

function rotate(n: number, xy: number[], rx: number, ry: number): void {
  if (ry === 0) {
    if (rx === 1) {
      xy[0] = n - 1 - xy[0];
      xy[1] = n - 1 - xy[1];
    }
    const t = xy[0];
    xy[0] = xy[1];
    xy[1] = t;
  }
}

/** Cumulative tile counts per zoom (PMTiles Hilbert ordering). */
const TZ_VALUES = [
  0, 1, 5, 21, 85, 341, 1365, 5461, 21845, 87381, 349525, 1398101, 5592405,
  22369621, 89478485, 357913941, 1431655765, 5726623061, 22906492245,
  91625968981, 366503875925, 1466015503701, 5864062014805, 23456248059221,
  93824992236885, 375299968947541, 1501199875790165,
];

/** Z/X/Y → PMTiles Hilbert tile id (throws for out-of-range coordinates). */
export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) {
    throw new Error("Tile zoom level exceeds max safe number limit (26)");
  }
  if (x > 2 ** z - 1 || y > 2 ** z - 1) {
    throw new Error("tile x/y outside zoom level bounds");
  }
  const acc = TZ_VALUES[z];
  const n = 2 ** z;
  let rx = 0;
  let ry = 0;
  let d = 0;
  const xy = [x, y];
  let s = n / 2;
  while (s > 0) {
    rx = (xy[0] & s) > 0 ? 1 : 0;
    ry = (xy[1] & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    rotate(s, xy, rx, ry);
    s = s / 2;
  }
  return acc + d;
}

/**
 * Stateless single-tile reader: header → root directory → (leaf directory) →
 * tile bytes, decompressed per the header's tile compression.
 */
export class PmtilesReader {
  private headerPromise: Promise<PmtilesHeader> | null = null;
  private readonly directoryCache = new Map<string, Promise<DirectoryEntry[]>>();

  constructor(private readonly readRange: RangeReader) {}

  async getHeader(): Promise<PmtilesHeader> {
    if (!this.headerPromise) {
      this.headerPromise = this.readRange(0, HEADER_SIZE).then((bytes) => {
        if (bytes.byteLength !== HEADER_SIZE) {
          throw new Error(`PMTiles header read returned ${bytes.byteLength} bytes`);
        }
        return parseHeader(bytes);
      });
      // Failed header reads must not poison retries forever.
      this.headerPromise.catch(() => {
        this.headerPromise = null;
      });
    }
    return this.headerPromise;
  }

  /**
   * Fetches one tile as decompressed bytes, or null when the tile (or zoom)
   * is not present in the archive. Range/decoding failures throw — the caller
   * decides how to map them.
   */
  async getTile(z: number, x: number, y: number): Promise<Uint8Array | null> {
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) return null;
    if (z < 0 || z > 26 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return null;

    const header = await this.getHeader();
    if (z < header.minZoom || z > header.maxZoom) return null;

    const tileId = zxyToTileId(z, x, y);
    let directoryOffset = header.rootDirectoryOffset;
    let directoryLength = header.rootDirectoryLength;
    for (let depth = 0; depth <= 3; depth++) {
      const entries = await this.readDirectory(header, directoryOffset, directoryLength);
      const entry = findTile(entries, tileId);
      if (!entry) return null;
      if (entry.runLength > 0) {
        const bytes = await this.readRange(header.tileDataOffset + entry.offset, entry.length);
        if (bytes.byteLength !== entry.length) {
          throw new Error(`Tile read returned ${bytes.byteLength} bytes, expected ${entry.length}`);
        }
        if (header.tileCompression === COMPRESSION_GZIP) return gunzipSync(bytes);
        if (header.tileCompression !== COMPRESSION_NONE) {
          throw new Error(`Unsupported tile compression ${header.tileCompression}`);
        }
        return bytes;
      }
      directoryOffset = header.leafDirectoryOffset + entry.offset;
      directoryLength = entry.length;
    }
    throw new Error("Maximum directory depth exceeded");
  }

  private readDirectory(
    header: PmtilesHeader,
    offset: number,
    length: number,
  ): Promise<DirectoryEntry[]> {
    const key = `${offset}:${length}`;
    let pending = this.directoryCache.get(key);
    if (!pending) {
      pending = this.readRange(offset, length).then((bytes) => {
        if (bytes.byteLength !== length) {
          throw new Error(`Directory read returned ${bytes.byteLength} bytes, expected ${length}`);
        }
        return deserializeDirectory(bytes, header.internalCompression);
      });
      pending.catch(() => {
        this.directoryCache.delete(key); // transient failures may be retried
      });
      this.directoryCache.set(key, pending);
    }
    return pending;
  }
}
