/**
 * Draw & analyze — dependency-free ESRI shapefile writer (Phase 4 export).
 *
 * Writes the three files a GIS expects for one polygon in WGS84:
 *
 *   <name>.shp  main file — Polygon (shape type 5), records big/little
 *               endian mixed exactly per the shapefile spec;
 *   <name>.dbf  dBASE III table — NAME (C80) + HA (N12,3);
 *   <name>.prj  ESRI WKT for GCS_WGS_1984 (so QGIS/ArcGIS place it right).
 *
 * then bundles them into a ZIP with STORE (no compression) entries — the
 * bytes are tiny and stored entries keep the writer trivially testable.
 * Ring winding follows the spec: exterior clockwise, holes counter-
 * clockwise (GeoJSON/RFC 7946 is the opposite, so rings are rewound).
 */
import type { Position } from "geojson";

export interface ShapefileParts {
  shp: Buffer;
  dbf: Buffer;
  prj: Buffer;
}

const SHP_POLYGON = 5;
const DBF_NAME_LENGTH = 80;
const DBF_HA_LENGTH = 12;
const DBF_HA_DECIMALS = 3;
/** Fixed DOS timestamp for deterministic archives (2026-01-01 00:00). */
const ZIP_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const ZIP_TIME = 0;

const PRJ_WGS84 =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,' +
  '298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

/** Signed area (shoelace): > 0 counter-clockwise, < 0 clockwise. */
function signedArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[i + 1]!;
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function rewind(ring: Position[], clockwise: boolean): Position[] {
  const isCw = signedArea(ring) < 0;
  return isCw === clockwise ? [...ring] : [...ring].reverse();
}

function ringPoints(ring: Position[]): Position[] {
  // Shapefile rings must be explicitly closed.
  const out = [...ring];
  const first = out[0];
  const last = out[out.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) out.push(first);
  return out;
}

/** Polygon → .shp bytes (100-byte header + one record per polygon). */
function writeShp(geometry: GeoJSON.Polygon): Buffer {
  const rings = geometry.coordinates.map((ring, index) =>
    rewind(ringPoints(ring), index === 0),
  );
  const points = rings.flat();
  if (points.length === 0) throw new Error("Polygon has no coordinates.");

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }

  const partOffsets: number[] = [];
  let offset = 0;
  for (const ring of rings) {
    partOffsets.push(offset);
    offset += ring.length;
  }

  // Record content: type(4) + box(32) + numParts(4) + numPoints(4)
  //                 + parts(4·n) + points(16·m)
  const contentBytes = 44 + partOffsets.length * 4 + points.length * 16;
  const content = Buffer.alloc(contentBytes);
  let cursor = 0;
  content.writeInt32LE(SHP_POLYGON, cursor);
  cursor += 4;
  content.writeDoubleLE(minX, cursor);
  cursor += 8;
  content.writeDoubleLE(minY, cursor);
  cursor += 8;
  content.writeDoubleLE(maxX, cursor);
  cursor += 8;
  content.writeDoubleLE(maxY, cursor);
  cursor += 8;
  content.writeInt32LE(rings.length, cursor);
  cursor += 4;
  content.writeInt32LE(points.length, cursor);
  cursor += 4;
  for (const part of partOffsets) {
    content.writeInt32LE(part, cursor);
    cursor += 4;
  }
  for (const [x, y] of points) {
    content.writeDoubleLE(x, cursor);
    cursor += 8;
    content.writeDoubleLE(y, cursor);
    cursor += 8;
  }

  const recordHeader = Buffer.alloc(8);
  recordHeader.writeInt32BE(1, 0); // record number (1-based)
  recordHeader.writeInt32BE(contentBytes / 2, 4); // length in 16-bit words

  const header = Buffer.alloc(100);
  header.writeInt32BE(9994, 0); // file code
  header.writeInt32BE((100 + 8 + contentBytes) / 2, 24); // file length (words)
  header.writeInt32LE(1000, 28); // version
  header.writeInt32LE(SHP_POLYGON, 32); // shape type
  header.writeDoubleLE(minX, 36);
  header.writeDoubleLE(minY, 44);
  header.writeDoubleLE(maxX, 52);
  header.writeDoubleLE(maxY, 60);
  // Z/M ranges stay 0 (2D polygon).

  return Buffer.concat([header, recordHeader, content]);
}

function dbfField(name: string, type: string, length: number, decimals: number): Buffer {
  const field = Buffer.alloc(32);
  field.write(name.slice(0, 10), 0, "ascii");
  field.write(type, 11, "ascii");
  field.writeUInt8(length, 16);
  field.writeUInt8(decimals, 17);
  return field;
}

function dbfText(value: string, length: number): Buffer {
  // dBASE strings are single-byte; non-latin1 characters degrade to "?".
  const ascii = value.replace(/[^\x20-\x7E]/g, "?").slice(0, length);
  return Buffer.from(ascii.padEnd(length, " "), "ascii");
}

function dbfNumber(value: number, length: number, decimals: number): Buffer {
  const text = value.toFixed(decimals);
  if (text.length > length) return Buffer.from(" ".repeat(length), "ascii");
  return Buffer.from(text.padStart(length, " "), "ascii");
}

/** Polygon attributes → .dbf bytes (one record). */
function writeDbf(attrs: { name: string; ha: number }): Buffer {
  const fields = [
    dbfField("NAME", "C", DBF_NAME_LENGTH, 0),
    dbfField("HA", "N", DBF_HA_LENGTH, DBF_HA_DECIMALS),
  ];
  const recordLength = 1 + DBF_NAME_LENGTH + DBF_HA_LENGTH; // deletion flag + fields
  const headerLength = 32 + fields.length * 32 + 1;

  const header = Buffer.alloc(32);
  header.writeUInt8(0x03, 0); // dBASE III
  const now = new Date();
  header.writeUInt8(now.getUTCFullYear() - 1900, 1);
  header.writeUInt8(now.getUTCMonth() + 1, 2);
  header.writeUInt8(now.getUTCDate(), 3);
  header.writeUInt32LE(1, 4); // record count
  header.writeUInt16LE(headerLength, 8);
  header.writeUInt16LE(recordLength, 10);

  const record = Buffer.concat([
    Buffer.from([0x20]), // not deleted
    dbfText(attrs.name, DBF_NAME_LENGTH),
    dbfNumber(attrs.ha, DBF_HA_LENGTH, DBF_HA_DECIMALS),
  ]);

  return Buffer.concat([
    header,
    ...fields,
    Buffer.from([0x0d]), // header terminator
    record,
    Buffer.from([0x1a]), // EOF
  ]);
}

/** Sanitised base file name ("My Shape 1" → "My_Shape_1"). */
export function shapefileBaseName(name: string): string {
  const cleaned = name
    .trim()
    // eslint-disable-next-line no-control-regex -- control chars never belong in file names
    .replace(/[\u0000-\u001F\u007F\\/:*?"<>|]+/g, "")
    .replace(/^\.+/, "")
    .replace(/\s+/g, "_")
    .slice(0, 60);
  return cleaned.length > 0 ? cleaned : "shape";
}

/** One polygon → the three shapefile parts (WGS84). */
export function polygonShapefile(
  geometry: GeoJSON.Polygon,
  attrs: { name: string; ha: number },
): ShapefileParts {
  return {
    shp: writeShp(geometry),
    dbf: writeDbf(attrs),
    prj: Buffer.from(PRJ_WGS84, "ascii"),
  };
}

/* ------------------------------------------------------------------ ZIP */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP archive with STORE entries (no compression). */
export function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(ZIP_TIME, 10);
    local.writeUInt16LE(ZIP_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, nameBytes, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(ZIP_TIME, 12);
    central.writeUInt16LE(ZIP_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // extra/comment/disk/attrs stay 0
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([central, nameBytes]));

    offset += local.length + nameBytes.length + size;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

/** The downloadable archive for one shape. */
export function shapefileZip(
  geometry: GeoJSON.Polygon,
  attrs: { name: string; ha: number },
): { baseName: string; zip: Buffer } {
  const baseName = shapefileBaseName(attrs.name);
  const parts = polygonShapefile(geometry, attrs);
  const zip = zipStore([
    { name: `${baseName}.shp`, data: parts.shp },
    { name: `${baseName}.dbf`, data: parts.dbf },
    { name: `${baseName}.prj`, data: parts.prj },
  ]);
  return { baseName, zip };
}
