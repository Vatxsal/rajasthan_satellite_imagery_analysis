import "./alias-hook"; // must be first: installs the "@/…" resolver before the lib graph loads

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { bbox as turfBbox } from "@turf/turf";
import type { BBox } from "../lib/data";
import { bboxAreaKm2 } from "../lib/cdse/geometry";
import { FIELDS_EDGE_EPS_DEG, FIELDS_TILE_ZOOM } from "../lib/fields/config";
import { CONF_FULL_SCALE, rawToConfidence, sampleConfidence, type ConfidenceWindow } from "../lib/fields/confidence";
import { decodeGeometry, decodeMvt, mvtGeometryToGeoJSON, tileCoordToLngLat } from "../lib/fields/mvt";
import {
  deserializeDirectory,
  findTile,
  HEADER_SIZE,
  parseHeader,
  PmtilesReader,
  zxyToTileId,
  type DirectoryEntry,
  type RangeReader,
} from "../lib/fields/pmtiles";
import { readVarint, zigzagDecode } from "../lib/fields/bytes";
import {
  buildFieldsRaw,
  filterFields,
  httpRangeReader,
  mergeEdgeDuplicates,
  tilesForBbox,
  type FieldCandidate,
  type FieldsDeps,
  type FieldsRawEntry,
} from "../lib/fields/query";
import { fieldsCacheKey } from "../lib/cache";

/**
 * Offline tests for the field boundary pipeline. All archive bytes live in
 * scripts/fixtures/*.b64 (regenerate with scripts/generate-fields-fixtures.mjs)
 * — the suite never touches the network.
 */

// ── fixtures ───────────────────────────────────────────────────────────────

const SOURCE_ROOT = path.resolve(__dirname, "..", "..");

function fixture(name: string): Buffer {
  const encoded = readFileSync(path.join(SOURCE_ROOT, "scripts", "fixtures", name), "utf8").replace(
    /\s+/g,
    "",
  );
  return Buffer.from(encoded, "base64");
}

const HEAD = fixture("fields-head.b64");
const LEAF = fixture("fields-leaf.b64");
const TILE_RAW = fixture("fields-tile-raw.b64");
const TILE = fixture("fields-tile.b64");
const FIXTURE_HEADER = parseHeader(HEAD);
const FIXTURE_TILE_ID = zxyToTileId(13, 5820, 3460);

function fixtureRoot(): DirectoryEntry[] {
  return deserializeDirectory(
    HEAD.subarray(
      FIXTURE_HEADER.rootDirectoryOffset,
      FIXTURE_HEADER.rootDirectoryOffset + FIXTURE_HEADER.rootDirectoryLength,
    ),
    FIXTURE_HEADER.internalCompression,
  );
}

/** Serves exactly the four fixture byte ranges; anything else throws. */
function fixtureRangeReader(): RangeReader {
  const root = fixtureRoot();
  const leafPointer = findTile(root, FIXTURE_TILE_ID);
  assert.ok(leafPointer && leafPointer.runLength === 0, "fixture root must point at a leaf");
  const leafOffset = FIXTURE_HEADER.leafDirectoryOffset + leafPointer.offset;
  const leafEntries = deserializeDirectory(LEAF, FIXTURE_HEADER.internalCompression);
  const tilePointer = findTile(leafEntries, FIXTURE_TILE_ID);
  assert.ok(tilePointer && tilePointer.runLength > 0, "fixture leaf must address the tile");
  const tileOffset = FIXTURE_HEADER.tileDataOffset + tilePointer.offset;

  // Regression lock on the exact ranges (from the real 3.3 GB archive).
  assert.equal(leafOffset, 45239);
  assert.equal(leafPointer.length, 10887);
  assert.equal(tileOffset, 2491436930);
  assert.equal(tilePointer.length, 239);

  return async (offset: number, length: number): Promise<Uint8Array> => {
    if (offset === 0 && length === HEADER_SIZE) return HEAD.subarray(0, length);
    if (
      offset === FIXTURE_HEADER.rootDirectoryOffset &&
      length === FIXTURE_HEADER.rootDirectoryLength
    ) {
      return HEAD.subarray(offset, offset + length);
    }
    if (offset === leafOffset && length === leafPointer.length) return LEAF;
    if (offset === tileOffset && length === tilePointer.length) return TILE_RAW;
    throw new Error(`fixture reader: unexpected range ${offset}+${length}`);
  };
}

// ── bytes / hilbert ────────────────────────────────────────────────────────

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let remaining = Math.floor(value);
  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0);
  return out;
}

test("readVarint decodes single- and multi-byte values, including >2^31", () => {
  const decode = (bytes: number[]): number => {
    const position = { buf: Uint8Array.from(bytes), pos: 0 };
    return readVarint(position);
  };
  assert.equal(decode([0x00]), 0);
  assert.equal(decode([0x7f]), 127);
  assert.equal(decode([0x80, 0x01]), 128);
  assert.equal(decode([0xac, 0x02]), 300);
  // 3,247,359,180 — a real IN_RJ.pmtiles tile offset (needs the 6-byte remainder).
  assert.equal(decode(encodeVarint(3_247_359_180)), 3_247_359_180);
  assert.equal(decode(encodeVarint(18_446_744_073_709_551_615 % 1000)), 18_446_744_073_709_551_615 % 1000);
});

test("zigzagDecode maps sint deltas", () => {
  assert.equal(zigzagDecode(0), 0);
  assert.equal(zigzagDecode(1), -1);
  assert.equal(zigzagDecode(2), 1);
  assert.equal(zigzagDecode(3), -2);
  assert.equal(zigzagDecode(4), 2);
});

test("zxyToTileId matches the reference Hilbert vectors", () => {
  const vectors: Array<[number, number, number, number]> = [
    [0, 0, 0, 0],
    [1, 0, 0, 1],
    [1, 1, 0, 4],
    [1, 0, 1, 2],
    [1, 1, 1, 3],
    [5, 3, 17, 609],
    [5, 17, 3, 1273],
    [10, 500, 600, 868901],
    [10, 600, 500, 1221583],
    [13, 5818, 3452, 77383025],
    [13, 5820, 3460, 77391135],
    [13, 0, 0, 22369621],
    [13, 8191, 8191, 67108863],
    [14, 10000, 9000, 226884757],
    [14, 16383, 16383, 268435455],
    [3, 7, 0, 84],
    [3, 0, 7, 42],
    [2, 2, 1, 18],
  ];
  for (const [z, x, y, tileId] of vectors) {
    assert.equal(zxyToTileId(z, x, y), tileId, `z${z}/${x}/${y}`);
  }
  assert.throws(() => zxyToTileId(27, 0, 0));
  assert.throws(() => zxyToTileId(3, 8, 0));
  assert.throws(() => zxyToTileId(3, 0, 8));
});

// ── header / directories ───────────────────────────────────────────────────

test("parseHeader reads the real IN_RJ archive header", () => {
  assert.equal(FIXTURE_HEADER.specVersion, 3);
  assert.equal(FIXTURE_HEADER.rootDirectoryOffset, 127);
  assert.equal(FIXTURE_HEADER.rootDirectoryLength, 60);
  assert.equal(FIXTURE_HEADER.leafDirectoryOffset, 1344);
  assert.equal(FIXTURE_HEADER.tileDataOffset, 68786);
  assert.equal(FIXTURE_HEADER.internalCompression, 2);
  assert.equal(FIXTURE_HEADER.tileCompression, 2);
  assert.equal(FIXTURE_HEADER.minZoom, 0);
  assert.equal(FIXTURE_HEADER.maxZoom, 13);
  for (const [key, expected, epsilon] of [
    ["minLon", 69.486031, 1e-6],
    ["minLat", 23.060094, 1e-6],
    ["maxLon", 78.2721509, 1e-6],
    ["maxLat", 30.204459, 1e-6],
  ] as Array<[keyof typeof FIXTURE_HEADER, number, number]>) {
    assert.ok(
      Math.abs(FIXTURE_HEADER[key] - expected) < epsilon,
      `${key}: ${FIXTURE_HEADER[key]} !≈ ${expected}`,
    );
  }
  assert.throws(() => parseHeader(HEAD.subarray(0, 64)), /truncated/);
  const wrongMagic = Buffer.from(HEAD);
  wrongMagic[0] = 0x00;
  assert.throws(() => parseHeader(wrongMagic), /magic/);
});

test("deserializeDirectory decodes the fixture root/leaf", () => {
  const root = fixtureRoot();
  assert.equal(root.length, 7);
  for (const entry of root) assert.equal(entry.runLength, 0, "root entries are leaf pointers");
  assert.deepEqual(root[0], { tileId: 0, offset: 0, length: 11330, runLength: 0 });
  assert.deepEqual(root[6], { tileId: 77410984, offset: 65495, length: 1947, runLength: 0 });

  const leafPointer = findTile(root, FIXTURE_TILE_ID);
  assert.ok(leafPointer);
  assert.equal(leafPointer.tileId, 77389672);
  assert.equal(leafPointer.offset, 43895);
  assert.equal(leafPointer.length, 10887);

  const leaf = deserializeDirectory(LEAF, 2);
  const tileEntry = findTile(leaf, FIXTURE_TILE_ID);
  assert.ok(tileEntry);
  assert.equal(tileEntry.tileId, FIXTURE_TILE_ID);
  assert.equal(tileEntry.runLength, 1);
  assert.equal(tileEntry.offset, 2491368144);
  assert.equal(tileEntry.length, 239);
});

test("findTile handles hits, runs, leaf pointers and misses", () => {
  const entries: DirectoryEntry[] = [
    { tileId: 10, offset: 0, length: 5, runLength: 1 },
    { tileId: 12, offset: 5, length: 5, runLength: 0 },
  ];
  assert.deepEqual(findTile(entries, 10), entries[0]);
  assert.equal(findTile(entries, 11), null); // run of 1 covers tile 10 only
  assert.deepEqual(findTile(entries, 12), entries[1]); // miss falls back to leaf pointer
  assert.equal(findTile(entries, 9), null); // before every entry
});

// ── PmtilesReader (offline e2e over the fixtures) ──────────────────────────

test("PmtilesReader resolves header, leaf and tile bytes", async () => {
  const reader = new PmtilesReader(fixtureRangeReader());
  const header = await reader.getHeader();
  assert.equal(header.maxZoom, 13);

  const tile = await reader.getTile(13, 5820, 3460);
  assert.ok(tile);
  assert.equal(tile.byteLength, TILE.byteLength);
  assert.deepEqual(Buffer.from(tile), TILE);

  // Not in the archive / out of range → null (never an error).
  assert.equal(await reader.getTile(14, 0, 0), null); // above header maxZoom
  assert.equal(await reader.getTile(99, 0, 0), null); // above the Hilbert limit
  assert.equal(await reader.getTile(13, 99999, 0), null);
  assert.equal(await reader.getTile(13, -1, 0), null);
  assert.equal(await reader.getTile(-1, 0, 0), null);
});

test("PmtilesReader surfaces range failures", async () => {
  const failing = new PmtilesReader(async () => {
    throw new Error("network down");
  });
  await assert.rejects(() => failing.getHeader(), /network down/);
  await assert.rejects(() => failing.getTile(13, 5820, 3460), /network down/);
});

test("PmtilesReader rejects short range responses", async () => {
  const short = new PmtilesReader(async () => new Uint8Array(10));
  await assert.rejects(() => short.getHeader(), /returned 10 bytes/);
});

// ── MVT decode ─────────────────────────────────────────────────────────────

test("decodeGeometry decodes deltas, closes rings and rejects unknown commands", () => {
  const commands = [
    (1 << 3) | 1, // MoveTo(1)
    zigzag(0),
    zigzag(0),
    (3 << 3) | 2, // LineTo(3)
    zigzag(1),
    zigzag(0),
    zigzag(0),
    zigzag(1),
    zigzag(-1),
    zigzag(0),
    7, // ClosePath
  ];
  const rings = decodeGeometry(commands);
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0], [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [0, 0],
  ]);
  assert.throws(() => decodeGeometry([(1 << 3) | 3, 0]), /Unknown MVT command/);
  assert.throws(() => decodeGeometry([(1 << 3) | 1, 0]), /Unexpected end of MVT geometry/);
});

const zigzag = (value: number): number => (value << 1) ^ (value >> 31);

function fieldHeader(no: number, wireType: number): number[] {
  return encodeVarint((no << 3) | wireType);
}
function varintField(no: number, value: number): number[] {
  return [...fieldHeader(no, 0), ...encodeVarint(value)];
}
function bytesField(no: number, bytes: number[]): number[] {
  return [...fieldHeader(no, 2), ...encodeVarint(bytes.length), ...bytes];
}
function stringField(no: number, value: string): number[] {
  return bytesField(no, Array.from(Buffer.from(value, "utf8")));
}
function packedVarints(no: number, values: number[]): number[] {
  return bytesField(no, values.flatMap(encodeVarint));
}

function valueString(value: string): number[] {
  return stringField(1, value);
}
function valueFloat(value: number): number[] {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value);
  return [...fieldHeader(2, 5), ...buffer];
}
function valueDouble(value: number): number[] {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return [...fieldHeader(3, 1), ...buffer];
}
function valueInt(value: number): number[] {
  return varintField(4, value);
}
function valueUint(value: number): number[] {
  return varintField(5, value);
}
function valueSint(value: number): number[] {
  return varintField(6, zigzag(value));
}
function valueBool(value: boolean): number[] {
  return varintField(7, value ? 1 : 0);
}

/** Emits MoveTo/LineTo/ClosePath for each ring, sharing the cursor across rings. */
function multiRingGeometry(rings: Array<Array<[number, number]>>): number[] {
  const out: number[] = [];
  let cursorX = 0;
  let cursorY = 0;
  for (const ring of rings) {
    const [startX, startY] = ring[0];
    out.push((1 << 3) | 1, zigzag(startX - cursorX), zigzag(startY - cursorY));
    cursorX = startX;
    cursorY = startY;
    const deltas: number[] = [];
    for (let i = 1; i < ring.length; i++) {
      const [nextX, nextY] = ring[i];
      deltas.push(zigzag(nextX - cursorX), zigzag(nextY - cursorY));
      cursorX = nextX;
      cursorY = nextY;
    }
    if (deltas.length > 0) out.push((deltas.length / 2 << 3) | 2, ...deltas);
    out.push(7); // ClosePath
  }
  return out;
}

interface FeatureSpec {
  id?: number;
  type: 1 | 2 | 3;
  tags?: number[];
  geometry: number[];
}

function featureMessage(spec: FeatureSpec): number[] {
  const parts: number[] = [];
  if (spec.id !== undefined) parts.push(...varintField(1, spec.id));
  if (spec.tags && spec.tags.length > 0) parts.push(...packedVarints(2, spec.tags));
  parts.push(...varintField(3, spec.type));
  parts.push(...bytesField(4, spec.geometry));
  return parts;
}

function layerMessage(spec: {
  name: string;
  extent?: number;
  keys?: string[];
  values?: number[][];
  features?: FeatureSpec[];
}): number[] {
  const parts: number[] = stringField(1, spec.name);
  for (const feature of spec.features ?? []) parts.push(...bytesField(2, featureMessage(feature)));
  for (const key of spec.keys ?? []) parts.push(...stringField(3, key));
  for (const value of spec.values ?? []) parts.push(...bytesField(4, value));
  if (spec.extent !== undefined) parts.push(...varintField(5, spec.extent));
  return parts;
}

function tileMessage(layers: number[][]): number[] {
  return layers.flatMap((layer) => bytesField(3, layer));
}

test("decodeMvt joins keys/values across every Value type", () => {
  const square = multiRingGeometry([
    [
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
    ],
  ]);
  const layers = decodeMvt(
    Uint8Array.from(
      tileMessage([
        layerMessage({
          name: "L",
          extent: 8192,
          keys: ["s", "d", "f", "i", "u", "z", "b"],
          values: [
            valueString("hi"),
            valueDouble(1.5),
            valueFloat(0.5),
            valueInt(7),
            valueUint(9),
            valueSint(-5),
            valueBool(true),
          ],
          features: [
            { id: 7, type: 3, tags: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6], geometry: square },
          ],
        }),
      ]),
    ),
  );
  const layer = layers.get("L");
  assert.ok(layer);
  assert.equal(layer.extent, 8192);
  assert.equal(layer.features.length, 1);
  const feature = layer.features[0];
  assert.equal(feature.id, 7);
  assert.equal(feature.type, 3);
  assert.equal(feature.properties.s, "hi");
  assert.equal(feature.properties.d, 1.5);
  assert.equal(feature.properties.f, 0.5);
  assert.equal(feature.properties.i, 7);
  assert.equal(feature.properties.u, 9);
  assert.equal(feature.properties.z, -5);
  assert.equal(feature.properties.b, true);

  const defaulted = decodeMvt(
    Uint8Array.from(
      tileMessage([layerMessage({ name: "plain", features: [{ type: 1, geometry: [9, 0, 0] }] })]),
    ),
  );
  assert.equal(defaulted.get("plain")?.extent, 4096);
});

test("decodeMvt classifies polygon rings like @mapbox/vector-tile", () => {
  const exterior: Array<[number, number]> = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const hole: Array<[number, number]> = [
    [2, 2],
    [2, 4],
    [4, 4],
    [4, 2],
  ];
  const exterior2: Array<[number, number]> = [
    [20, 20],
    [30, 20],
    [30, 30],
    [20, 30],
  ];
  const degenerate: Array<[number, number]> = [
    [0, 0],
    [5, 0],
    [0, 0],
  ];

  const geometryOf = (rings: Array<Array<[number, number]>>): GeoJSON.Geometry | null => {
    const layers = decodeMvt(
      Uint8Array.from(
        tileMessage([
          layerMessage({
            name: "t",
            features: [{ type: 3, geometry: multiRingGeometry(rings) }],
          }),
        ]),
      ),
    );
    const layer = layers.get("t");
    assert.ok(layer);
    assert.equal(layer.features.length, 1);
    return mvtGeometryToGeoJSON(
      layer.features[0].type,
      layer.features[0].rings,
      0,
      0,
      0,
      layer.extent,
    );
  };

  // Opposite windings → one polygon with a hole, whichever ring comes first.
  const withHole = geometryOf([exterior, hole]);
  assert.ok(withHole && withHole.type === "Polygon");
  assert.equal((withHole as GeoJSON.Polygon).coordinates.length, 2);
  const reversed = geometryOf([hole, exterior]);
  assert.ok(reversed && reversed.type === "Polygon");
  assert.equal((reversed as GeoJSON.Polygon).coordinates.length, 2);

  // Same winding → two separate polygons.
  const sameWinding = geometryOf([exterior, exterior2]);
  assert.ok(sameWinding && sameWinding.type === "MultiPolygon");
  assert.equal((sameWinding as GeoJSON.MultiPolygon).coordinates.length, 2);

  // Zero-area ring is dropped.
  const withDegenerate = geometryOf([exterior, degenerate]);
  assert.ok(withDegenerate && withDegenerate.type === "Polygon");
  assert.equal((withDegenerate as GeoJSON.Polygon).coordinates.length, 1);
});

test("tileCoordToLngLat projects tile grid coordinates", () => {
  const [west, north] = tileCoordToLngLat(13, 5820, 3460, 0, 0, 4096);
  const [east, south] = tileCoordToLngLat(13, 5820, 3460, 4096, 4096, 4096);
  assert.equal(west, 75.76171875);
  assert.equal(east, 75.8056640625);
  // Tile y edges are exact Web-Mercator inverse projections (see mercYToLat
  // defined with the merge fixtures below).
  assert.equal(north, mercYToLat(3460 / 8192));
  assert.equal(south, mercYToLat(3461 / 8192));

  const [originLng, originLat] = tileCoordToLngLat(0, 0, 0, 0, 0, 4096);
  assert.equal(originLng, -180);
  assert.ok(Math.abs(originLat - 85.0511287798066) < 1e-9);
  const [centerLng, centerLat] = tileCoordToLngLat(0, 0, 0, 2048, 2048, 4096);
  assert.equal(centerLng, 0);
  assert.ok(Math.abs(centerLat) < 1e-12);
});

test("fixture tile decodes into the 2024 and 2025 field layers", () => {
  const layers = decodeMvt(TILE);
  const expectedRingLength: Record<string, number> = { "2024": 75, "2025": 83 };
  for (const year of ["2024", "2025"]) {
    const layer = layers.get(year);
    assert.ok(layer, `layer ${year}`);
    assert.equal(layer.extent, 4096);
    assert.equal(layer.features.length, 1, `layer ${year}`);
    const feature = layer.features[0];
    assert.equal(feature.type, 3);
    assert.equal(feature.rings.length, 1);
    assert.equal(feature.rings[0].length, expectedRingLength[year], `${year} ring length`);
  }
  const area2024 = Number(layers.get("2024")?.features[0].properties["metrics:area"]);
  const area2025 = Number(layers.get("2025")?.features[0].properties["metrics:area"]);
  assert.ok(Math.abs(area2024 - 33665.141) < 1e-4, `2024 area ${area2024}`);
  assert.ok(Math.abs(area2025 - 53917.633) < 1e-4, `2025 area ${area2025}`);
  assert.ok(area2024 > 0 && area2025 > 0);

  const geometry = mvtGeometryToGeoJSON(
    layers.get("2024")!.features[0].type,
    layers.get("2024")!.features[0].rings,
    FIELDS_TILE_ZOOM,
    5820,
    3460,
    4096,
  );
  assert.ok(geometry && geometry.type === "Polygon");
  const ring = (geometry as GeoJSON.Polygon).coordinates[0];
  assert.equal(ring[0].length, 2);
  assert.deepEqual(ring[0], ring[ring.length - 1]);
  for (const [lng, lat] of ring) {
    assert.ok(lng > 75.5 && lng < 76, `lng ${lng}`);
    assert.ok(lat > 26.7 && lat < 27.1, `lat ${lat}`);
  }
});

// ── confidence ─────────────────────────────────────────────────────────────

test("rawToConfidence rescales, clamps and rejects nodata", () => {
  assert.ok(Math.abs((rawToConfidence(0.4) ?? -1) - (0.4 / CONF_FULL_SCALE) * 100) < 1e-9);
  assert.equal(rawToConfidence(CONF_FULL_SCALE), 100);
  assert.equal(rawToConfidence(2), 100); // clamp above full scale
  assert.equal(rawToConfidence(0), 0); // a real 0 %, not null
  assert.equal(rawToConfidence(-1), null); // raster nodata
  assert.equal(rawToConfidence(Number.NaN), null);
  assert.equal(rawToConfidence(null), null);
  assert.equal(rawToConfidence(undefined), null);
});

test("sampleConfidence reads the nearest cell of a window", () => {
  const window: ConfidenceWindow = {
    west: 75,
    north: 27,
    pxLon: 0.5,
    pxLat: 0.5,
    width: 2,
    height: 2,
    values: [0.4, CONF_FULL_SCALE, -1, 0.1],
  };
  assert.ok(Math.abs((sampleConfidence(window, 75.1, 26.9) ?? -1) - (0.4 / CONF_FULL_SCALE) * 100) < 1e-9);
  assert.equal(sampleConfidence(window, 75.6, 26.7), 100); // row 0, col 1
  assert.equal(sampleConfidence(window, 75.6, 26.4), rawToConfidence(0.1)); // row 1, col 1
  assert.equal(sampleConfidence(window, 75.1, 26.4), null); // nodata cell
  assert.equal(sampleConfidence(window, 74, 30), null); // outside the window
  assert.equal(sampleConfidence(null, 75.1, 26.9), null);
});

// ── bbox helpers ───────────────────────────────────────────────────────────

test("bboxAreaKm2 is a sane planar estimate", () => {
  const area = bboxAreaKm2([0, 0, 1, 1]);
  assert.ok(area > 12_250 && area < 12_350, String(area));
});

test("tilesForBbox lists exactly the overlapping z13 tiles", () => {
  const one = tilesForBbox([75.762, 26.897, 75.805, 26.9], FIELDS_TILE_ZOOM);
  assert.equal(one.length, 1);
  assert.deepEqual(one[0], { x: 5820, y: 3460 });

  const two = tilesForBbox([75.75, 26.88, 75.77, 26.89], FIELDS_TILE_ZOOM);
  assert.equal(two.length, 2);
  assert.deepEqual(
    two.map((tile) => `${tile.x}/${tile.y}`).sort(),
    ["5819/3460", "5820/3460"],
  );

  assert.throws(
    () => tilesForBbox([75, 26, 76, 27], FIELDS_TILE_ZOOM),
    (error: unknown) => {
      const contract = error as { status?: number; code?: string };
      return contract.status === 400 && contract.code === "AREA_TOO_LARGE";
    },
  );
});

// ── cross-tile merge ───────────────────────────────────────────────────────

const Z4_WEST_OF_9 = (9 / 16) * 360 - 180; // edge between tiles x=8 and x=9 → 22.5
const mercYToLat = (mercatorY: number): number =>
  (Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180) / Math.PI;
const Z4_EDGE_LAT_8_9 = mercYToLat(9 / 16); // edge between tiles y=8 and y=9

function candidate(
  ring: Array<[number, number]>,
  areaM2: number,
  tileX: number,
  tileY: number,
): FieldCandidate {
  const geometry: GeoJSON.Polygon = { type: "Polygon", coordinates: [ring] };
  const [west, south, east, north] = turfBbox(geometry) as [number, number, number, number];
  return { geometry, areaM2, bbox: [west, south, east, north], tileX, tileY };
}

function closedRing(west: number, south: number, east: number, north: number): Array<[number, number]> {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

test("mergeEdgeDuplicates unions twins and keeps distinct fields", () => {
  const edge = Z4_WEST_OF_9; // 22.5
  const twin: Array<[number, number]> = [
    [edge - 0.002, -7.002],
    [edge + 0.002, -7.002],
    [edge + 0.002, -6.998],
    [edge - 0.002, -6.998],
    [edge - 0.002, -7.002],
  ];
  const leftOnly = closedRing(edge - 0.004, -7.002, edge - 0.0015, -6.998);
  const rightOnly = closedRing(edge + 0.0015, -7.002, edge + 0.004, -6.998);
  const farAway = closedRing(70, -7.002, 70.004, -6.998);

  const merged = mergeEdgeDuplicates(
    [
      candidate(twin, 1000, 8, 8),
      candidate(twin, 900, 9, 8), // same field, second tile (twin)
      candidate(leftOnly, 500, 8, 8),
      candidate(rightOnly, 400, 9, 8), // adjacent strip but disjoint → distinct
      candidate(farAway, 300, 11, 8), // non-adjacent tile → never tested
    ],
    { zoom: 4, epsDeg: FIELDS_EDGE_EPS_DEG },
  );

  assert.equal(merged.length, 4); // twins joined; the other three stay distinct
  const areas = merged.map((entry) => entry.areaM2).sort((a, b) => b - a);
  assert.deepEqual(areas, [1000, 500, 400, 300]);
  // The merged twin keeps a single geometry covering the original square.
  const twinCopy = merged.find((entry) => entry.areaM2 === 1000);
  assert.ok(twinCopy);
  assert.equal(twinCopy.geometry.type, "Polygon");
  const ring = (twinCopy.geometry as GeoJSON.Polygon).coordinates[0];
  assert.ok(ring.some(([lng]) => Math.abs(lng - (edge - 0.002)) < 1e-9));
  assert.ok(ring.some(([lng]) => Math.abs(lng - (edge + 0.002)) < 1e-9));
});

test("mergeEdgeDuplicates merges across a horizontal tile edge", () => {
  const edgeLat = Z4_EDGE_LAT_8_9;
  const straddler = closedRing(10, edgeLat - 0.002, 10.004, edgeLat + 0.002);
  const merged = mergeEdgeDuplicates(
    [
      candidate(straddler, 700, 8, 8),
      candidate(straddler, 650, 8, 9),
      candidate(closedRing(10, edgeLat - 0.5, 10.004, edgeLat - 0.4), 100, 8, 11),
    ],
    { zoom: 4, epsDeg: FIELDS_EDGE_EPS_DEG },
  );
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((entry) => entry.areaM2).sort((a, b) => b - a), [700, 100]);
});

test("mergeEdgeDuplicates returns input untouched when nothing is near an edge", () => {
  const midTile = closedRing(5, -5, 5.01, -4.99);
  const merged = mergeEdgeDuplicates(
    [candidate(midTile, 10, 8, 8), candidate(closedRing(6, -5, 6.01, -4.99), 20, 8, 8)],
    { zoom: 4, epsDeg: FIELDS_EDGE_EPS_DEG },
  );
  assert.equal(merged.length, 2);
});

// ── response shaping ───────────────────────────────────────────────────────

function syntheticField(areaM2: number, confidence: number | null): FieldsRawEntry["features"][number] {
  return {
    type: "Feature",
    id: String(areaM2),
    geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
    properties: { areaM2, confidence },
  };
}

test("filterFields applies thresholds, caps and counters", () => {
  const entry: FieldsRawEntry = {
    bbox: [0, 0, 1, 1],
    year: 2024,
    confidenceAvailable: true,
    features: [
      syntheticField(500, null),
      syntheticField(400, 50),
      syntheticField(300, 70),
      syntheticField(200, 95),
    ],
  };

  const all = filterFields(entry, 0, 100);
  assert.equal(all.count, 4);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.excluded, { confidence: 0, noConfidence: 0 });
  assert.equal(all.totalAreaM2, 1400);

  const filtered = filterFields(entry, 69, 100);
  assert.equal(filtered.count, 2);
  assert.deepEqual(filtered.excluded, { confidence: 1, noConfidence: 1 });
  assert.equal(filtered.totalAreaM2, 500);
  assert.deepEqual(
    filtered.fields.features.map((feature) => feature.properties.areaM2),
    [300, 200],
  );

  const capped = filterFields(entry, 0, 2);
  assert.equal(capped.count, 2);
  assert.equal(capped.truncated, true);
  assert.equal(capped.totalAreaM2, 900);
  assert.deepEqual(capped.excluded, { confidence: 0, noConfidence: 0 });

  const both = filterFields(entry, 69, 1);
  assert.equal(both.count, 1);
  assert.equal(both.truncated, true);
  assert.deepEqual(both.excluded, { confidence: 1, noConfidence: 1 });
  assert.equal(both.totalAreaM2, 300);
});

test("fieldsCacheKey rounds the bbox and keys the year", () => {
  const base = { bbox: [75.76171875, 26.9, 75.8056640625, 26.91] as BBox, year: 2024 };
  const same = fieldsCacheKey({ bbox: [base.bbox[0] + 1e-7, base.bbox[1], base.bbox[2], base.bbox[3]], year: 2024 });
  const shifted = fieldsCacheKey({ bbox: [base.bbox[0] + 1e-4, base.bbox[1], base.bbox[2], base.bbox[3]], year: 2024 });
  const nextYear = fieldsCacheKey({ bbox: base.bbox, year: 2025 });
  assert.equal(fieldsCacheKey(base), same);
  assert.notEqual(fieldsCacheKey(base), shifted);
  assert.notEqual(fieldsCacheKey(base), nextYear);
});

// ── buildFieldsRaw (full offline pipeline) ─────────────────────────────────

const TILE_WEST = 75.76171875;
const TILE_EAST = 75.8056640625;
const TILE_NORTH = mercYToLat(3460 / 8192);
const TILE_SOUTH = mercYToLat(3461 / 8192);
const SELECTION_PAD = 0.0002;

function selectionForYear(year: 2024 | 2025): BBox {
  const layers = decodeMvt(TILE);
  const layer = layers.get(String(year));
  assert.ok(layer);
  const geometry = mvtGeometryToGeoJSON(
    layer.features[0].type,
    layer.features[0].rings,
    FIELDS_TILE_ZOOM,
    5820,
    3460,
    layer.extent,
  );
  assert.ok(geometry);
  const [west, south, east, north] = turfBbox({ type: "Feature", geometry, properties: {} });
  return [
    Math.max(west - SELECTION_PAD, TILE_WEST + 1e-6),
    Math.max(south - SELECTION_PAD, TILE_SOUTH + 1e-6),
    Math.min(east + SELECTION_PAD, TILE_EAST - 1e-6),
    Math.min(north + SELECTION_PAD, TILE_NORTH - 1e-6),
  ];
}

function offlineDeps(confidence?: ConfidenceWindow | null): FieldsDeps {
  return {
    readRange: fixtureRangeReader(),
    readConfidence: async () => confidence ?? null,
  };
}

test("buildFieldsRaw extracts the fixture field for 2024", async () => {
  const bbox = selectionForYear(2024);
  const entry = await buildFieldsRaw(offlineDeps(), { bbox, year: 2024 });
  assert.deepEqual(entry.bbox, bbox);
  assert.equal(entry.year, 2024);
  assert.equal(entry.confidenceAvailable, false);
  assert.equal(entry.features.length, 1);
  const feature = entry.features[0];
  assert.ok(Math.abs(feature.properties.areaM2 - 33665.141) < 1e-4);
  assert.equal(feature.properties.confidence, null);
  assert.equal(feature.properties.flag, undefined);
  assert.match(String(feature.id), /^[0-9a-f]{12}$/);
  assert.equal(feature.geometry.type, "Polygon");
});

test("buildFieldsRaw extracts the fixture field for 2025", async () => {
  const bbox = selectionForYear(2025);
  const entry = await buildFieldsRaw(offlineDeps(), { bbox, year: 2025 });
  assert.equal(entry.features.length, 1);
  const feature = entry.features[0];
  assert.ok(Math.abs(feature.properties.areaM2 - 53917.633) < 1e-4);
  assert.equal(feature.properties.confidence, null);
});

test("buildFieldsRaw attaches sampled confidence when the COG window is readable", async () => {
  const bbox = selectionForYear(2024);
  const window: ConfidenceWindow = {
    west: TILE_WEST,
    north: TILE_NORTH,
    pxLon: 0.01,
    pxLat: 0.01,
    width: 8,
    height: 8,
    values: new Array(64).fill(0.4),
  };
  const entry = await buildFieldsRaw(offlineDeps(window), { bbox, year: 2024 });
  assert.equal(entry.confidenceAvailable, true);
  assert.equal(entry.features.length, 1);
  const confidence = entry.features[0].properties.confidence;
  assert.ok(confidence !== null);
  assert.ok(Math.abs(confidence - (0.4 / CONF_FULL_SCALE) * 100) < 1e-6, String(confidence));
});

test("buildFieldsRaw maps range failures to 503 FIELDS_UNAVAILABLE", async () => {
  // A bbox outside the fixture tile reaches a leaf range we do not serve.
  await assert.rejects(
    () =>
      buildFieldsRaw(offlineDeps(), { bbox: [70.0, 25.0, 70.01, 25.01], year: 2024 }),
    (error: unknown) => {
      const contract = error as { status?: number; code?: string };
      return contract.status === 503 && contract.code === "FIELDS_UNAVAILABLE";
    },
  );

  await assert.rejects(
    () =>
      buildFieldsRaw(
        {
          readRange: async () => {
            throw new Error("network down");
          },
          readConfidence: async () => null,
        },
        { bbox: selectionForYear(2024), year: 2024 },
      ),
    (error: unknown) => {
      const contract = error as { status?: number; code?: string };
      return contract.status === 503 && contract.code === "FIELDS_UNAVAILABLE";
    },
  );
});

test("buildFieldsRaw rejects oversized tile spans before reading anything", async () => {
  await assert.rejects(
    () =>
      buildFieldsRaw(
        {
          readRange: async () => {
            throw new Error("must not be called");
          },
          readConfidence: async () => null,
        },
        { bbox: [75, 26, 76, 27], year: 2024 },
      ),
    (error: unknown) => {
      const contract = error as { status?: number; code?: string };
      return contract.status === 400 && contract.code === "AREA_TOO_LARGE";
    },
  );
});

test("buildFieldsRaw skips the confidence read for empty selections", async () => {
  let confidenceReads = 0;
  const entry = await buildFieldsRaw(
    {
      readRange: fixtureRangeReader(),
      readConfidence: async () => {
        confidenceReads += 1;
        return null;
      },
    },
    { bbox: selectionForYear(2024), year: 2024 },
  );
  assert.equal(entry.features.length, 1);
  assert.equal(confidenceReads, 1);

  const empty = await buildFieldsRaw(
    {
      readRange: fixtureRangeReader(),
      readConfidence: async () => {
        confidenceReads += 1;
        return null;
      },
    },
    // West strip of the same tile: the fixture field sits in the east end, so
    // this selection decodes to zero candidates.
    { bbox: [75.762, 26.864, 75.765, 26.867], year: 2024 },
  );
  assert.equal(empty.features.length, 0);
  assert.equal(empty.confidenceAvailable, false);
  assert.equal(confidenceReads, 1); // still exactly one: the successful build above
});

// ── httpRangeReader guards ─────────────────────────────────────────────────

interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  bytes?: Uint8Array;
  contentLengthHeader?: string;
  cancelled?: boolean;
}

function fakeFetchResponse(fake: FakeResponse): Response {
  const headers = new Headers();
  if (fake.contentLengthHeader !== undefined) headers.set("content-length", fake.contentLengthHeader);
  const body = {
    cancel: async () => {
      if (fake.cancelled !== undefined) fake.cancelled = true;
    },
  };
  return {
    status: fake.status,
    headers,
    body,
    arrayBuffer: async () => {
      const bytes = fake.bytes ?? new Uint8Array(0);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  } as unknown as Response;
}

test("httpRangeReader only trusts exact 206 range responses", async () => {
  const originalFetch = (globalThis as { fetch: typeof fetch }).fetch;
  try {
    const good: FakeResponse = { status: 206, bytes: Uint8Array.from([1, 2, 3]) };
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      fakeFetchResponse(good)) as typeof fetch;
    const reader = httpRangeReader("https://example.invalid/archive.pmtiles");
    assert.deepEqual(Array.from(await reader(0, 3)), [1, 2, 3]);

    const short: FakeResponse = { status: 206, bytes: Uint8Array.from([1]) };
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      fakeFetchResponse(short)) as typeof fetch;
    await assert.rejects(() => reader(0, 3), (error: unknown) => {
      const contract = error as { status?: number; code?: string };
      return contract.status === 503 && contract.code === "FIELDS_UNAVAILABLE";
    });

    const ignoredRange: FakeResponse = {
      status: 200,
      contentLengthHeader: "3305384968",
      cancelled: false,
    };
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      fakeFetchResponse(ignoredRange)) as typeof fetch;
    await assert.rejects(() => reader(0, 100), /range requests/);
    assert.equal(ignoredRange.cancelled, true); // body aborted, never downloaded

    const serverError: FakeResponse = { status: 500 };
    (globalThis as { fetch: typeof fetch }).fetch = (async () =>
      fakeFetchResponse(serverError)) as typeof fetch;
    await assert.rejects(() => reader(0, 100), /HTTP 500/);

    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    await assert.rejects(() => reader(0, 100), /unreachable/);
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  }
});
