/**
 * Zero-dependency Mapbox Vector Tile decoder (protobuf subset as written by
 * tippecanoe) — `@mapbox/vector-tile` v1 alone is 256 KB over our dependency
 * budget, and v3/pbf are ESM-only (the node --test harness runs CJS).
 *
 * Ring orientation follows the battle-tested @mapbox/vector-tile grouping:
 * the first ring with non-zero area defines the exterior winding and the
 * opposite winding becomes a hole; ties split into separate polygons.
 */
import { zigzagDecode } from "./bytes";

export type MvtPropertyValue = string | number | boolean | null;

export type MvtGeometryType = 0 | 1 | 2 | 3; // unknown | point | line | polygon

export interface MvtFeature {
  id?: number;
  type: MvtGeometryType;
  properties: Record<string, MvtPropertyValue>;
  /** Rings in tile units (extent grid); polygon rings are closed (first == last). */
  rings: Array<Array<[number, number]>>;
}

export interface MvtLayer {
  name: string;
  extent: number;
  features: MvtFeature[];
}

const DEFAULT_EXTENT = 4096;
const UTF8 = new TextDecoder();

class Reader {
  private pos = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  readVarint(): number {
    let result = 0;
    let shift = 1;
    for (;;) {
      if (this.pos >= this.bytes.length) throw new Error("Unexpected end of MVT data");
      const b = this.bytes[this.pos++];
      result += (b & 0x7f) * shift;
      if ((b & 0x80) === 0) break;
      shift *= 128;
      if (shift > 2 ** 63) throw new Error("MVT varint too long");
    }
    return result;
  }

  readBytes(): Uint8Array {
    const length = this.readVarint();
    if (this.pos + length > this.bytes.length) throw new Error("Unexpected end of MVT data");
    const out = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  readString(): string {
    return UTF8.decode(this.readBytes());
  }

  readFloat64(): number {
    if (this.pos + 8 > this.bytes.length) throw new Error("Unexpected end of MVT data");
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return value;
  }

  readFloat32(): number {
    if (this.pos + 4 > this.bytes.length) throw new Error("Unexpected end of MVT data");
    const value = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return value;
  }

  skip(wireType: number): void {
    if (wireType === 0) {
      this.readVarint();
    } else if (wireType === 1) {
      this.pos += 8;
    } else if (wireType === 2) {
      this.readBytes();
    } else if (wireType === 5) {
      this.pos += 4;
    } else {
      throw new Error(`Unsupported MVT wire type ${wireType}`);
    }
    if (this.pos > this.bytes.length) throw new Error("Unexpected end of MVT data");
  }
}

/** Reads a packed-or-singular varint field into `target`. */
function collectVarints(reader: Reader, wireType: number, target: number[]): void {
  if (wireType === 2) {
    const packed = new Reader(reader.readBytes());
    while (!packed.done) target.push(packed.readVarint());
  } else if (wireType === 0) {
    target.push(reader.readVarint());
  } else {
    throw new Error(`Expected varint field, got wire type ${wireType}`);
  }
}

function parseValue(bytes: Uint8Array): MvtPropertyValue {
  const reader = new Reader(bytes);
  let value: MvtPropertyValue = "";
  while (!reader.done) {
    const key = reader.readVarint();
    const field = key >>> 3;
    const wireType = key & 0x7;
    if (field === 1 && wireType === 2) {
      value = reader.readString();
    } else if (field === 2 && wireType === 5) {
      value = reader.readFloat32();
    } else if (field === 3 && wireType === 1) {
      value = reader.readFloat64();
    } else if (field === 4 && wireType === 0) {
      // int64 as two's-complement varint: values ≥ 2^63 are negatives.
      const raw = reader.readVarint();
      value = raw >= 2 ** 63 ? raw - 2 ** 64 : raw;
    } else if (field === 5 && wireType === 0) {
      value = reader.readVarint();
    } else if (field === 6 && wireType === 0) {
      value = zigzagDecode(reader.readVarint());
    } else if (field === 7 && wireType === 0) {
      value = reader.readVarint() !== 0;
    } else {
      reader.skip(wireType);
    }
  }
  return value;
}

/**
 * Decodes an MVT geometry command stream (already varint-decoded) into rings.
 * ClosePath appends the closing point (like @mapbox/vector-tile) so polygon
 * rings are always closed. Throws on unknown commands — a malformed tile must
 * never decode silently into wrong shapes.
 */
export function decodeGeometry(commands: number[]): Array<Array<[number, number]>> {
  const rings: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> | null = null;
  let command = 1;
  let length = 0;
  let x = 0;
  let y = 0;
  let i = 0;

  const next = (): number => {
    if (i >= commands.length) throw new Error("Unexpected end of MVT geometry");
    return commands[i++];
  };

  const closePath = (): void => {
    if (!current) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) {
      current.push([first[0], first[1]]);
    }
    rings.push(current);
    current = null;
  };

  while (i < commands.length) {
    if (length <= 0) {
      const commandLength = next();
      command = commandLength & 0x7;
      length = commandLength >> 3;
      if (command === 7) {
        // ClosePath always carries a count of 0 — execute it directly so the
        // zero-count guard below never swallows it.
        closePath();
        continue;
      }
      if (length === 0) continue;
    }
    length--;

    if (command === 1) {
      // MoveTo
      x += zigzagDecode(next());
      y += zigzagDecode(next());
      if (current) rings.push(current);
      current = [[x, y]];
    } else if (command === 2) {
      // LineTo
      x += zigzagDecode(next());
      y += zigzagDecode(next());
      if (current) current.push([x, y]);
    } else if (command === 7) {
      // ClosePath with a non-zero count (malformed) — close and drain it.
      closePath();
    } else {
      throw new Error(`Unknown MVT command ${command}`);
    }
  }
  if (current) rings.push(current);
  return rings;
}

function parseFeature(
  bytes: Uint8Array,
  keys: string[],
  values: MvtPropertyValue[],
): MvtFeature | null {
  const reader = new Reader(bytes);
  let id: number | undefined;
  let type: MvtGeometryType = 0;
  const tags: number[] = [];
  const geometry: number[] = [];

  while (!reader.done) {
    const key = reader.readVarint();
    const field = key >>> 3;
    const wireType = key & 0x7;
    if (field === 1 && wireType === 0) {
      id = reader.readVarint();
    } else if (field === 2) {
      collectVarints(reader, wireType, tags);
    } else if (field === 3 && wireType === 0) {
      type = reader.readVarint() as MvtGeometryType;
    } else if (field === 4) {
      collectVarints(reader, wireType, geometry);
    } else {
      reader.skip(wireType);
    }
  }

  const properties: Record<string, MvtPropertyValue> = {};
  for (let i = 0; i + 1 < tags.length; i += 2) {
    const key = keys[tags[i]];
    if (key === undefined) continue;
    properties[key] = values[tags[i + 1]] ?? null;
  }
  return { id, type, properties, rings: decodeGeometry(geometry) };
}

function parseLayer(bytes: Uint8Array): MvtLayer {
  const reader = new Reader(bytes);
  let name = "";
  let extent = DEFAULT_EXTENT;
  const keys: string[] = [];
  const values: MvtPropertyValue[] = [];
  const featureBytes: Uint8Array[] = [];

  while (!reader.done) {
    const key = reader.readVarint();
    const field = key >>> 3;
    const wireType = key & 0x7;
    if (field === 1 && wireType === 2) {
      name = reader.readString();
    } else if (field === 2 && wireType === 2) {
      featureBytes.push(reader.readBytes());
    } else if (field === 3 && wireType === 2) {
      keys.push(reader.readString());
    } else if (field === 4 && wireType === 2) {
      values.push(parseValue(reader.readBytes()));
    } else if (field === 5 && wireType === 0) {
      extent = reader.readVarint();
    } else {
      reader.skip(wireType);
    }
  }

  // Features may reference keys/values declared later in the byte stream, so
  // properties are joined only after the whole layer has been walked.
  const features: MvtFeature[] = [];
  for (const bytes of featureBytes) {
    const feature = parseFeature(bytes, keys, values);
    if (feature && feature.type !== 0) features.push(feature);
  }
  return { name, extent, features };
}

/** Decodes a Tile message into layers keyed by layer name. */
export function decodeMvt(bytes: Uint8Array): Map<string, MvtLayer> {
  const reader = new Reader(bytes);
  const layers = new Map<string, MvtLayer>();
  while (!reader.done) {
    const key = reader.readVarint();
    const field = key >>> 3;
    const wireType = key & 0x7;
    if (field === 3 && wireType === 2) {
      const layer = parseLayer(reader.readBytes());
      layers.set(layer.name, layer);
    } else {
      reader.skip(wireType);
    }
  }
  return layers;
}

const round7 = (value: number): number => Math.round(value * 1e7) / 1e7;

/** Tile-local grid coordinates → WGS84 lng/lat (Web Mercator, EPSG:3857). */
export function tileCoordToLngLat(
  z: number,
  tileX: number,
  tileY: number,
  x: number,
  y: number,
  extent: number,
): [number, number] {
  const worldX = (tileX + x / extent) / 2 ** z;
  const worldY = (tileY + y / extent) / 2 ** z;
  const lng = worldX * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY))) * 180) / Math.PI;
  return [lng, lat];
}

/**
 * Ring signed area with the @mapbox/vector-tile formula. Sign convention
 * follows the encoder; grouping adapts to the first ring (see classifyRings).
 */
function signedArea(ring: Array<[number, number]>): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p1 = ring[i];
    const p2 = ring[j];
    sum += (p2[0] - p1[0]) * (p1[1] + p2[1]);
  }
  return sum;
}

/** Groups rings into polygons: first non-zero ring sets the exterior winding. */
function classifyRings(
  rings: Array<Array<[number, number]>>,
): Array<Array<Array<[number, number]>>> {
  if (rings.length === 0) return [];
  if (rings.length === 1) return [rings];
  const polygons: Array<Array<Array<[number, number]>>> = [];
  let polygon: Array<Array<[number, number]>> | undefined;
  let exteriorIsNegative: boolean | undefined;
  for (const ring of rings) {
    const area = signedArea(ring);
    if (area === 0) continue;
    if (exteriorIsNegative === undefined) exteriorIsNegative = area < 0;
    if (exteriorIsNegative === area < 0) {
      if (polygon) polygons.push(polygon);
      polygon = [ring];
    } else if (polygon) {
      polygon.push(ring);
    }
  }
  if (polygon) polygons.push(polygon);
  return polygons;
}

function closeRing(ring: Array<[number, number]>): Array<[number, number]> {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, [first[0], first[1]]];
}

/** Converts decoded tile rings to a projected, 7-dp GeoJSON geometry (or null). */
export function mvtGeometryToGeoJSON(
  type: MvtGeometryType,
  rings: Array<Array<[number, number]>>,
  z: number,
  tileX: number,
  tileY: number,
  extent: number,
): GeoJSON.Geometry | null {
  if (rings.length === 0) return null;
  const project = (ring: Array<[number, number]>): GeoJSON.Position[] =>
    closeRing(ring).map(([x, y]) => {
      const [lng, lat] = tileCoordToLngLat(z, tileX, tileY, x, y, extent);
      return [round7(lng), round7(lat)];
    });

  if (type === 1) {
    const coordinates = rings.map((ring) => {
      const [lng, lat] = tileCoordToLngLat(z, tileX, tileY, ring[0][0], ring[0][1], extent);
      return [round7(lng), round7(lat)];
    });
    return coordinates.length === 1
      ? { type: "Point", coordinates: coordinates[0] }
      : { type: "MultiPoint", coordinates };
  }

  if (type === 2) {
    const coordinates = rings.map(project);
    return coordinates.length === 1
      ? { type: "LineString", coordinates: coordinates[0] }
      : { type: "MultiLineString", coordinates };
  }

  if (type === 3) {
    const polygons = classifyRings(rings).map((polygon) => polygon.map(project));
    if (polygons.length === 0) return null;
    return polygons.length === 1
      ? { type: "Polygon", coordinates: polygons[0] }
      : { type: "MultiPolygon", coordinates: polygons };
  }

  return null;
}
