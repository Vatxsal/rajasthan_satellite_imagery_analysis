/**
 * Hand-rolled single-strip uint8 GeoTIFF writer for the classified change map
 * (classic TIFF, little-endian, Adobe Deflate) — keeps the export dependency
 * free. Georeferencing: ModelPixelScale + ModelTiepoint + GeoKeyDirectory
 * (EPSG:4326), plus GDAL_NODATA = 255 (outside polygon).
 *
 * Layout: [8-byte header → IFD → out-of-line values → deflated strip].
 */
import { deflateSync } from "node:zlib";

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_DOUBLE = 12;

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Inline value (already LE) when ≤ 4 bytes; otherwise raw out-of-line bytes. */
  bytes: Buffer;
  outOfLine: boolean;
}

function inlineShort(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function inlineLong(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

function doubles(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 8);
  values.forEach((v, i) => buf.writeDoubleLE(v, i * 8));
  return buf;
}

function shorts(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeUInt16LE(v, i * 2));
  return buf;
}

function align(offset: number, boundary: number): number {
  return Math.ceil(offset / boundary) * boundary;
}

export interface ClassGeoTiffInput {
  /** Raw class codes (0-6, 255 = outside). */
  classGrid: Uint8Array;
  width: number;
  height: number;
  /** [west, south, east, north] EPSG:4326. */
  bbox: [number, number, number, number];
}

export function encodeClassGeoTiff(input: ClassGeoTiffInput): Buffer {
  const { classGrid, width, height, bbox } = input;
  const [west, , east, north] = bbox;
  const pxLon = Math.abs(east - west) / width;
  const pxLat = Math.abs(north - southOf(bbox)) / height;

  const strip = deflateSync(classGrid);

  // GeoKeyDirectory: header + 3 keys (1024 GTModelType, 1025 GTRasterType,
  // 2048 GeographicType) — sorted ascending as the spec requires.
  const geoKeys = shorts([1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]);
  const gdalMeta = Buffer.from(
    '<GDALMetadata><Item name="description" sample="0">change class: 0 no-change, 1 veg gain, 2 veg loss, 3 bare/built, 4 water gain, 5 water loss, 6 masked, 255 outside</Item></GDALMetadata>\0',
    "ascii",
  );
  const nodata = Buffer.from("255\0", "ascii"); // 4 bytes → inline

  const entries: Entry[] = [
    { tag: 256, type: TYPE_LONG, count: 1, bytes: inlineLong(width), outOfLine: false },
    { tag: 257, type: TYPE_LONG, count: 1, bytes: inlineLong(height), outOfLine: false },
    { tag: 258, type: TYPE_SHORT, count: 1, bytes: inlineShort(8), outOfLine: false },
    { tag: 259, type: TYPE_SHORT, count: 1, bytes: inlineShort(8), outOfLine: false },
    { tag: 262, type: TYPE_SHORT, count: 1, bytes: inlineShort(1), outOfLine: false },
    { tag: 273, type: TYPE_LONG, count: 1, bytes: Buffer.alloc(4), outOfLine: false }, // strip offset, patched below
    { tag: 277, type: TYPE_SHORT, count: 1, bytes: inlineShort(1), outOfLine: false },
    { tag: 278, type: TYPE_LONG, count: 1, bytes: inlineLong(height), outOfLine: false },
    { tag: 279, type: TYPE_LONG, count: 1, bytes: inlineLong(strip.length), outOfLine: false },
    { tag: 284, type: TYPE_SHORT, count: 1, bytes: inlineShort(1), outOfLine: false },
    { tag: 339, type: TYPE_SHORT, count: 1, bytes: inlineShort(1), outOfLine: false },
    { tag: 33550, type: TYPE_DOUBLE, count: 3, bytes: doubles([pxLon, pxLat, 0]), outOfLine: true },
    { tag: 33922, type: TYPE_DOUBLE, count: 6, bytes: doubles([0, 0, 0, west, north, 0]), outOfLine: true },
    { tag: 34735, type: TYPE_SHORT, count: geoKeys.length / 2, bytes: geoKeys, outOfLine: true },
    { tag: 42112, type: TYPE_ASCII, count: gdalMeta.length, bytes: gdalMeta, outOfLine: true },
    { tag: 42113, type: TYPE_ASCII, count: nodata.length, bytes: nodata, outOfLine: false },
  ];
  entries.sort((a, b) => a.tag - b.tag);

  const ifdSize = 2 + entries.length * 12 + 4;
  let extraOffset = align(8 + ifdSize, 8);
  const outOfLinePlace: Array<{ entry: Entry; offset: number }> = [];
  for (const entry of entries) {
    if (!entry.outOfLine) continue;
    const boundary = entry.type === TYPE_DOUBLE ? 8 : 2;
    extraOffset = align(extraOffset, boundary);
    outOfLinePlace.push({ entry, offset: extraOffset });
    extraOffset += entry.bytes.length;
  }

  const stripOffset = align(extraOffset, 8);
  const total = stripOffset + strip.length;
  const out = Buffer.alloc(total);

  // Header (little-endian TIFF).
  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4); // IFD at offset 8

  // IFD.
  out.writeUInt16LE(entries.length, 8);
  let pos = 10;
  const placeByEntry = new Map<Entry, number>(outOfLinePlace.map((p) => [p.entry, p.offset]));
  for (const entry of entries) {
    out.writeUInt16LE(entry.tag, pos);
    out.writeUInt16LE(entry.type, pos + 2);
    out.writeUInt32LE(entry.count, pos + 4);
    const dataOffset = placeByEntry.get(entry);
    if (dataOffset !== undefined) {
      out.writeUInt32LE(dataOffset, pos + 8);
      entry.bytes.copy(out, dataOffset);
    } else {
      entry.bytes.copy(out, pos + 8);
    }
    pos += 12;
  }
  out.writeUInt32LE(0, pos); // no next IFD

  // StripOffsets patch (tag 273 lives inline in the IFD — written after layout).
  // Find it again cheaply: entries are sorted, tag 273 index is known.
  const stripEntryIndex = entries.findIndex((e) => e.tag === 273);
  const stripEntryPos = 10 + stripEntryIndex * 12;
  out.writeUInt32LE(stripOffset, stripEntryPos + 8);

  strip.copy(out, stripOffset);
  return out;
}

function southOf(bbox: [number, number, number, number]): number {
  return bbox[1];
}
