import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { feature, pointOnFeature, polygon } from "@turf/turf";
import { POST } from "../app/api/shapes/validate/route";
import { districtsFc } from "../lib/data/boundaries";
import { ssoCookie, guestCookie, useReadyAuthGate } from "./test-session";

/** Route-level contract for POST /api/shapes/validate: guard flow (401/403/
 *  400), the shared spec-order rules, metrics and the normalised geometry
 *  that save/analyze endpoints will store. The Rajasthan outline comes from
 *  the bundled JSON import — no fetch happens anywhere in these tests. */

const VALIDATE_URL = "http://localhost/api/shapes/validate";

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

async function send(
  payload: unknown,
  options: { cookie?: string | null; origin?: string; raw?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  const request = new Request(VALIDATE_URL, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(payload),
  });
  const response = await POST(request);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("validate: without a session the gate answers 401", async () => {
  const { status, body } = await send({ geometry: rajasthanSquare() });
  assert.equal(status, 401);
  assert.equal(body.code, "UNAUTHENTICATED");
});

test("validate: cross-origin POSTs are rejected before auth", async () => {
  const { status, body } = await send(
    { geometry: rajasthanSquare() },
    { origin: "https://evil.example" },
  );
  assert.equal(status, 403);
  assert.equal(body.code, "CROSS_ORIGIN");
});

test("validate: malformed bodies are 400 INVALID_REQUEST", async () => {
  const cookie = await ssoCookie();
  const notJson = await send(null, { cookie, raw: "{nope" });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.code, "INVALID_JSON");

  const missing = await send({}, { cookie });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "INVALID_REQUEST");

  const badCoord = await send(
    { geometry: { type: "Polygon", coordinates: [[[75, 26], [75.1, "x"], [75, 26]]] } },
    { cookie },
  );
  assert.equal(badCoord.status, 400);
});

test("validate: a valid shape answers ok with metrics and a closed ring", async () => {
  const cookie = await ssoCookie();
  const { status, body } = await send({ geometry: rajasthanSquare() }, { cookie });
  assert.equal(status, 200);

  const validity = body.validity as { ok: boolean };
  assert.equal(validity.ok, true, JSON.stringify(body.validity));

  const metrics = body.metrics as { areaM2: number; vertices: number; bboxSideKm: number };
  assert.ok(metrics.areaM2 > 0 && metrics.areaM2 < 100 * 1e6, "under the 100 km² cap");
  assert.equal(metrics.vertices, 4);
  assert.ok(metrics.bboxSideKm > 0 && metrics.bboxSideKm < 25);

  const normalized = body.normalized as GeoJSON.Polygon;
  const ring = normalized.coordinates[0]!;
  assert.deepEqual(ring[0], ring[ring.length - 1], "ring closes");
});

test("validate: duplicate seed points normalise away before counting", async () => {
  const cookie = await ssoCookie();
  const square = rajasthanSquare();
  // Terra's double-seeded first click: [p1, p1, p2, p3, p4, p1].
  square.coordinates[0].splice(1, 0, [...square.coordinates[0][0]!]);
  const { status, body } = await send({ geometry: square }, { cookie });
  assert.equal(status, 200);
  assert.equal((body.validity as { ok: boolean }).ok, true);
  assert.equal((body.metrics as { vertices: number }).vertices, 4);
  assert.equal((body.normalized as GeoJSON.Polygon).coordinates[0]!.length, 5);
});

test("validate: outside-Rajasthan shapes answer ok:false with the reason", async () => {
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
  const { status, body } = await send({ geometry: outside }, { cookie });
  assert.equal(status, 200);
  const validity = body.validity as { ok: boolean; kind: string; reason: string };
  assert.equal(validity.ok, false);
  assert.equal(validity.kind, "error");
  assert.equal(validity.reason, "outside-rajasthan");
});

test("validate: unfinished drafts answer pending, not error", async () => {
  const cookie = await ssoCookie();
  const draft: GeoJSON.LineString = {
    type: "LineString",
    coordinates: [
      [75.0, 26.0],
      [75.1, 26.0],
    ],
  };
  const { status, body } = await send({ geometry: draft }, { cookie });
  assert.equal(status, 200);
  const validity = body.validity as { ok: boolean; kind: string; reason: string };
  assert.equal(validity.ok, false);
  assert.equal(validity.kind, "pending");
  assert.equal(validity.reason, "structure");
  assert.equal((body.metrics as { vertices: number }).vertices, 2);
});

test("validate: guest sessions may validate (draw.basic is open to guests)", async () => {
  const cookie = await guestCookie();
  const { status } = await send({ geometry: rajasthanSquare() }, { cookie });
  assert.equal(status, 200);
});

test("validate: DRAW_MAX_* env overrides the shared constants (server-authoritative)", async () => {
  const cookie = await ssoCookie();
  process.env.DRAW_MAX_KM2 = "1"; // default is 100 — this square is ~17 km²
  try {
    // Validate answers 200 with the verdict inside; the override shows up
    // as an area error quoting "1 km²" instead of the 100 km² constant.
    const { status, body } = await send({ geometry: rajasthanSquare() }, { cookie });
    assert.equal(status, 200);
    const validity = body.validity as { ok: boolean; reason: string; message: string };
    assert.equal(validity.ok, false);
    assert.equal(validity.reason, "area");
    assert.match(validity.message, /1 km²/, "message quotes the env limit, not the constant");
  } finally {
    delete process.env.DRAW_MAX_KM2;
    const holder = globalThis as unknown as EnvHolder;
    if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  }
});
