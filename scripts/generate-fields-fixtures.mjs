/**
 * Regenerates scripts/fixtures/*.b64 — the offline PMTiles/MVT fixtures used
 * by scripts/fields.test.ts — from the official Fields of the World archive:
 *   https://data.source.coop/ftw/global-data/predictions/vectors/alpha/
 *   results-by-admin-conf/admin:country_code=IN/IN_RJ.pmtiles
 * Field boundaries © Fields of the World, CC BY 4.0 (via Source Cooperative).
 *
 * Manual run only — the test suite never touches the network:
 *   node scripts/generate-fields-fixtures.mjs
 */
import { gunzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ARCHIVE =
  "https://data.source.coop/ftw/global-data/predictions/vectors/alpha/results-by-admin-conf/admin:country_code=IN/IN_RJ.pmtiles";
const HEADER_SIZE = 127;
const Z = 13;
const X = 5820;
const Y = 3460;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// ── minimal PMTiles v3 readers (ports of protomaps/PMTiles, BSD) ────────────

function toNum(low, high) {
  return (high >>> 0) * 0x100000000 + (low >>> 0);
}

function readVarintRemainder(l, p) {
  const buf = p.buf;
  let b = buf[p.pos++];
  let h = (b & 0x70) >> 4;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x7f) << 3;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x7f) << 10;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x7f) << 17;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x7f) << 24;
  if (b < 0x80) return toNum(l, h);
  b = buf[p.pos++];
  h |= (b & 0x01) << 31;
  if (b < 0x80) return toNum(l, h);
  throw new Error("Expected varint not more than 10 bytes");
}

function readVarint(p) {
  const buf = p.buf;
  let b = buf[p.pos++];
  let val = b & 0x7f;
  if (b < 0x80) return val;
  b = buf[p.pos++];
  val |= (b & 0x7f) << 7;
  if (b < 0x80) return val;
  b = buf[p.pos++];
  val |= (b & 0x7f) << 14;
  if (b < 0x80) return val;
  b = buf[p.pos++];
  val |= (b & 0x7f) << 21;
  if (b < 0x80) return val;
  b = buf[p.pos];
  val |= (b & 0x0f) << 28;
  return readVarintRemainder(val, p);
}

function deserializeDirectory(buffer) {
  const p = { buf: buffer, pos: 0 };
  const numEntries = readVarint(p);
  const entries = [];
  let lastId = 0;
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint(p);
    entries.push({ tileId: lastId + v, offset: 0, length: 0, runLength: 1 });
    lastId += v;
  }
  for (let i = 0; i < numEntries; i++) entries[i].runLength = readVarint(p);
  for (let i = 0; i < numEntries; i++) entries[i].length = readVarint(p);
  for (let i = 0; i < numEntries; i++) {
    const v = readVarint(p);
    if (v === 0 && i > 0) {
      entries[i].offset = entries[i - 1].offset + entries[i - 1].length;
    } else {
      entries[i].offset = v - 1;
    }
  }
  return entries;
}

function findTile(entries, tileId) {
  let m = 0;
  let n = entries.length - 1;
  while (m <= n) {
    const k = (n + m) >> 1;
    const cmp = tileId - entries[k].tileId;
    if (cmp > 0) m = k + 1;
    else if (cmp < 0) n = k - 1;
    else return entries[k];
  }
  if (n >= 0) {
    if (entries[n].runLength === 0) return entries[n];
    if (tileId - entries[n].tileId < entries[n].runLength) return entries[n];
  }
  return null;
}

function rotate(n, xy, rx, ry) {
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

const TZ_VALUES = [
  0, 1, 5, 21, 85, 341, 1365, 5461, 21845, 87381, 349525, 1398101, 5592405,
  22369621, 89478485, 357913941, 1431655765, 5726623061, 22906492245,
  91625968981, 366503875925, 1466015503701, 5864062014805, 23456248059221,
  93824992236885, 375299968947541, 1501199875790165,
];

function zxyToTileId(z, x, y) {
  if (z > 26) throw new Error("Tile zoom level exceeds max safe number limit (26)");
  if (x > 2 ** z - 1 || y > 2 ** z - 1) throw new Error("tile x/y outside zoom level bounds");
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

// ── fetching + writing ─────────────────────────────────────────────────────

async function fetchRange(offset, length) {
  const response = await fetch(ARCHIVE, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (response.status !== 206) throw new Error(`expected HTTP 206, got ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== length) throw new Error(`expected ${length} bytes, got ${bytes.length}`);
  return bytes;
}

function writeFixture(name, bytes) {
  writeFileSync(join(FIXTURES, name), `${bytes.toString("base64")}\n`);
  console.log(`${name}: ${bytes.length} bytes`);
}

async function main() {
  mkdirSync(FIXTURES, { recursive: true });

  const headerBytes = await fetchRange(0, HEADER_SIZE);
  const view = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  const u64 = (o) => Number(view.getBigUint64(o, true));
  const header = {
    rootOff: u64(8),
    rootLen: u64(16),
    leafOff: u64(40),
    tileOff: u64(56),
    internalCompression: view.getUint8(97),
    tileCompression: view.getUint8(98),
    minZoom: view.getUint8(100),
    maxZoom: view.getUint8(101),
  };
  console.log("header:", header);

  const head = await fetchRange(0, header.rootOff + header.rootLen);
  const root = deserializeDirectory(gunzipSync(head.subarray(header.rootOff, header.rootOff + header.rootLen)));
  console.log("root entries:", JSON.stringify(root));

  const tileId = zxyToTileId(Z, X, Y);
  console.log(`tileId(${Z}/${X}/${Y}) = ${tileId}`);
  const leafPointer = findTile(root, tileId);
  if (!leafPointer) throw new Error("no root entry for the fixture tile");
  console.log("root entry:", leafPointer);

  let tilePointer = leafPointer;
  if (leafPointer.runLength === 0) {
    const leaf = await fetchRange(header.leafOff + leafPointer.offset, leafPointer.length);
    writeFixture("fields-leaf.b64", leaf);
    console.log(`leaf range: ${header.leafOff + leafPointer.offset}+${leafPointer.length}`);
    const leafEntries = deserializeDirectory(gunzipSync(leaf));
    tilePointer = findTile(leafEntries, tileId);
    if (!tilePointer || tilePointer.runLength === 0) throw new Error("tile not addressed by its leaf");
    console.log("leaf entry:", tilePointer);
  }

  const raw = await fetchRange(header.tileOff + tilePointer.offset, tilePointer.length);
  writeFixture("fields-tile-raw.b64", raw);
  console.log(`tile range: ${header.tileOff + tilePointer.offset}+${tilePointer.length}`);

  const tile = header.tileCompression === 2 ? gunzipSync(raw) : raw;
  writeFixture("fields-tile.b64", tile);
  writeFixture("fields-head.b64", head);
  console.log("done");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
