import assert from "node:assert/strict";
import test from "node:test";
import * as shapefile from "shapefile";
import {
  polygonShapefile,
  shapefileBaseName,
  shapefileZip,
  zipStore,
} from "../lib/server/shapefile";

/** Contract for the dependency-free shapefile writer (Phase 4): the .shp /
 *  .dbf / .prj bytes must round-trip through the reference reader
 *  (mbostock's shapefile, a devDependency), ring winding must follow the
 *  spec, and the STORE zip must carry the three entries with matching
 *  CRC-32s. */

/** Exterior CCW + one hole CW, as RFC 7946 requires (the writer rewinds). */
function squareWithHole(): GeoJSON.Polygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [75.0, 26.0],
        [75.1, 26.0],
        [75.1, 26.1],
        [75.0, 26.1],
        [75.0, 26.0],
      ],
      [
        [75.02, 26.02],
        [75.02, 26.04],
        [75.04, 26.04],
        [75.04, 26.02],
        [75.02, 26.02],
      ],
    ],
  };
}

function plainSquare(): GeoJSON.Polygon {
  return {
    type: "Polygon",
    coordinates: [
      [
        [75.0, 26.0],
        [75.1, 26.0],
        [75.1, 26.1],
        [75.0, 26.1],
        [75.0, 26.0],
      ],
    ],
  };
}

/** Order/direction-insensitive key for one ring (winding and the starting
 *  vertex may legitimately differ between writer and reader). */
function ringKey(ring: GeoJSON.Position[]): string {
  return ring
    .map(([x, y]) => `${Number(x).toFixed(6)},${Number(y).toFixed(6)}`)
    .sort()
    .join("|");
}

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

interface ZipEntry {
  name: string;
  data: Buffer;
  crc: number;
  method: number;
}

/** Minimal STORE-zip reader: EOCD → central directory → local headers. */
function readZipEntries(zip: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.notEqual(eocd, -1, "zip has an end-of-central-directory record");

  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16); // central directory offset
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50, "central directory signature");
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const size = zip.readUInt32LE(cursor + 20);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");

    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, "local header signature");
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    entries.push({
      name,
      data: Buffer.from(zip.subarray(dataStart, dataStart + size)),
      crc,
      method,
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test("shapefile: shp+dbf round-trip through the reference reader", async () => {
  const parts = polygonShapefile(squareWithHole(), { name: "My Shape 1", ha: 12.345 });

  // .shp header sanity: big-endian file code, little-endian type 5.
  assert.equal(parts.shp.readInt32BE(0), 9994);
  assert.equal(parts.shp.readInt32LE(32), 5);

  const collection = await shapefile.read(parts.shp, parts.dbf);
  assert.equal(collection.features.length, 1);

  const feature = collection.features[0]!;
  const geometry = feature.geometry;
  assert.ok(geometry, "feature has a geometry");
  assert.equal(geometry.type, "Polygon");
  const rings = geometry.type === "Polygon" ? geometry.coordinates : [];
  assert.equal(rings.length, 2, "exterior + hole survive");
  assert.equal(ringKey(rings[0]!), ringKey(squareWithHole().coordinates[0]!));
  assert.equal(ringKey(rings[1]!), ringKey(squareWithHole().coordinates[1]!));

  assert.equal(feature.properties?.NAME, "My Shape 1");
  assert.ok(
    Math.abs((feature.properties?.HA as number) - 12.345) < 1e-9,
    `HA round-trips, got ${String(feature.properties?.HA)}`,
  );
});

test("shapefile: prj is ESRI WGS84 text", () => {
  const parts = polygonShapefile(plainSquare(), { name: "x", ha: 1 });
  const prj = parts.prj.toString("ascii");
  assert.ok(prj.includes("GCS_WGS_1984"), prj);
  assert.ok(prj.includes("WGS_1984"), prj);
  assert.ok(prj.startsWith("GEOGCS["), prj);
});

test("shapefile: base names are file-system safe", () => {
  assert.equal(shapefileBaseName("My Shape 1"), "My_Shape_1");
  assert.equal(shapefileBaseName("  spaced out  "), "spaced_out");
  assert.equal(shapefileBaseName("a/b\\c:d*e?f\"g<h>i|j"), "abcdefghij");
  assert.equal(shapefileBaseName(".hidden"), "hidden");
  assert.equal(shapefileBaseName("   "), "shape", "empty after cleaning");
});

test("shapefile: shapefileZip carries .shp/.dbf/.prj with valid CRCs", () => {
  const geometry = plainSquare();
  const { baseName, zip } = shapefileZip(geometry, { name: "My Field", ha: 4.5 });
  assert.equal(baseName, "My_Field");

  const entries = readZipEntries(zip);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["My_Field.shp", "My_Field.dbf", "My_Field.prj"],
  );
  for (const entry of entries) {
    assert.equal(entry.method, 0, `${entry.name} is STOREd`);
    assert.equal(crc32(entry.data), entry.crc, `${entry.name} CRC-32 matches`);
  }

  const parts = polygonShapefile(geometry, { name: "My Field", ha: 4.5 });
  assert.deepEqual(entries[0]!.data, parts.shp);
  assert.deepEqual(entries[1]!.data, parts.dbf);
  assert.deepEqual(entries[2]!.data, parts.prj);
});

test("shapefile: zipStore output is deterministic", () => {
  const entries = [
    { name: "a.txt", data: Buffer.from("hello") },
    { name: "b.bin", data: Buffer.from([1, 2, 3]) },
  ];
  assert.deepEqual(zipStore(entries), zipStore(entries));
});
