import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { feature, pointOnFeature, polygon } from "@turf/turf";
import * as shapefile from "shapefile";
import { POST } from "../app/api/shapes/export/route";
import { districtsFc } from "../lib/data/boundaries";
import { measureDrawGeometry } from "../lib/draw/geometry";
import { ssoCookie, guestCookie, useReadyAuthGate } from "./test-session";

/** Route-level contract for POST /api/shapes/export: the same guard flow as
 *  validate (401/403/400), server-authoritative shape rejection, and a real
 *  shapefile zip on success (.shp/.dbf/.prj, verified with the reference
 *  reader). The Rajasthan outline comes from the bundled JSON — no fetch. */

const EXPORT_URL = "http://localhost/api/shapes/export";

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "1000";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.org";
  useReadyAuthGate();

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();
}

beforeEach(resetState);

/** Small square (~17 km²) inside Rajasthan — anchored to the first district's
 *  interior so it passes the inside-check regardless of the boundary set. */
function rajasthanSquare(): GeoJSON.Polygon {
  const district = districtsFc.features[0];
  assert.ok(district?.geometry, "boundaries fixture must load");
  const [lng, lat] = pointOnFeature(feature(district.geometry)).geometry.coordinates;
  const d = 0.02;
  return polygon([
    [
      [lng - d, lat - d],
      [lng + d, lat - d],
      [lng + d, lat + d],
      [lng - d, lat + d],
      [lng - d, lat - d],
    ],
  ]).geometry;
}

interface SendResult {
  status: number;
  headers: Headers;
  json: Record<string, unknown> | null;
  bytes: Buffer | null;
}

async function send(
  payload: unknown,
  options: { cookie?: string | null; origin?: string; raw?: string } = {},
): Promise<SendResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  const request = new Request(EXPORT_URL, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(payload),
  });
  const response = await POST(request);
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return {
      status: response.status,
      headers: response.headers,
      json: (await response.json()) as Record<string, unknown>,
      bytes: null,
    };
  }
  return {
    status: response.status,
    headers: response.headers,
    json: null,
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

interface ZipEntry {
  name: string;
  data: Buffer;
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
    entries.push({ name, data: Buffer.from(zip.subarray(dataStart, dataStart + size)) });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test("export: without a session the gate answers 401", async () => {
  const { status, json } = await send({ geometry: rajasthanSquare() });
  assert.equal(status, 401);
  assert.equal(json?.code, "UNAUTHENTICATED");
});

test("export: cross-origin POSTs are rejected before auth", async () => {
  const { status, json } = await send(
    { geometry: rajasthanSquare() },
    { origin: "https://evil.example" },
  );
  assert.equal(status, 403);
  assert.equal(json?.code, "CROSS_ORIGIN");
});

test("export: malformed bodies are 400 INVALID_*", async () => {
  const cookie = await ssoCookie();
  const notJson = await send(null, { cookie, raw: "{nope" });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.json?.code, "INVALID_JSON");

  const missing = await send({}, { cookie });
  assert.equal(missing.status, 400);
  assert.equal(missing.json?.code, "INVALID_REQUEST");

  const notPolygon = await send(
    { geometry: { type: "Point", coordinates: [75, 26] } },
    { cookie },
  );
  assert.equal(notPolygon.status, 400);
  assert.equal(notPolygon.json?.code, "INVALID_REQUEST");
});

test("export: invalid shapes are 400 SHAPE_INVALID with validity", async () => {
  const cookie = await ssoCookie();
  const outside = polygon([
    [
      [80.0, 10.0],
      [80.02, 10.0],
      [80.02, 10.02],
      [80.0, 10.02],
      [80.0, 10.0],
    ],
  ]).geometry;
  const { status, json } = await send({ geometry: outside }, { cookie });
  assert.equal(status, 400);
  assert.equal(json?.code, "SHAPE_INVALID");
  const validity = json?.validity as { ok: boolean; reason: string };
  assert.equal(validity.ok, false);
  assert.equal(validity.reason, "outside-rajasthan");
});

test("export: a valid shape downloads a three-entry shapefile zip", async () => {
  const cookie = await ssoCookie();
  const geometry = rajasthanSquare();
  const { status, headers, json, bytes } = await send(
    { name: "My Field", geometry },
    { cookie },
  );
  assert.equal(status, 200, JSON.stringify(json));
  assert.ok(bytes, "binary body");
  assert.equal(headers.get("content-type"), "application/zip");
  assert.equal(
    headers.get("content-disposition"),
    'attachment; filename="My_Field.zip"',
  );
  assert.equal(headers.get("cache-control"), "no-store");

  const entries = readZipEntries(bytes!);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ["My_Field.shp", "My_Field.dbf", "My_Field.prj"],
  );

  // Reference-reader round-trip of what the route actually served.
  const shp = entries.find((entry) => entry.name.endsWith(".shp"))!;
  const dbf = entries.find((entry) => entry.name.endsWith(".dbf"))!;
  const collection = await shapefile.read(shp.data, dbf.data);
  assert.equal(collection.features.length, 1);
  const drawn = collection.features[0]!;
  assert.equal(drawn.geometry?.type, "Polygon");
  assert.equal(drawn.properties?.NAME, "My Field");

  const metrics = measureDrawGeometry(geometry);
  assert.ok(metrics, "the square has metrics");
  const expectedHa = metrics.areaM2 / 10_000;
  assert.ok(
    Math.abs((drawn.properties?.HA as number) - expectedHa) < 0.01,
    `HA ≈ ${expectedHa.toFixed(3)}, got ${String(drawn.properties?.HA)}`,
  );

  const prj = entries.find((entry) => entry.name.endsWith(".prj"))!;
  assert.ok(prj.data.toString("ascii").includes("GCS_WGS_1984"));
});

test("export: guests are refused with FORBIDDEN_ROLE (draw.export.shapefile is SSO-only)", async () => {
  const cookie = await guestCookie();
  const { status, json } = await send({ geometry: rajasthanSquare() }, { cookie });
  assert.equal(status, 403);
  assert.equal(json?.code, "FORBIDDEN_ROLE");
  assert.equal(json?.required, "sso");
});
