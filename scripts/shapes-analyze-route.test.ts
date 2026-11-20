import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { feature, pointOnFeature, polygon } from "@turf/turf";
import { POST } from "../app/api/shapes/analyze/route";
import { districtsFc } from "../lib/data/boundaries";
import { ssoCookie, guestCookie, useReadyAuthGate } from "./test-session";

/** Route-level guard flow for POST /api/shapes/analyze in mock mode
 *  (NEXT_PUBLIC_DATA_SOURCE unset → "mock", the CI default). Every test
 *  stops before any CDSE work: guard failures answer as JSON, the PU
 *  pre-flight runs on pure arithmetic, and the mock source is the last gate
 *  before the catalogue — so a regression that reaches the network fails
 *  loudly instead of waiting on Copernicus. The NDJSON happy path lives in
 *  shapes-analyze-stream.test.ts (cdse mode). */

const ANALYZE_URL = "http://localhost/api/shapes/analyze";

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "1000";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.org";
  useReadyAuthGate();
  delete process.env.PER_ANALYSIS_PU_LIMIT;
  delete process.env.COMPARE_RATE_LIMIT_PER_MIN;

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

function validBody(): Record<string, unknown> {
  return {
    area: { kind: "shape", geometry: rajasthanSquare(), name: "Test shape" },
    fromDate: "2026-10-01",
    toDate: "2026-10-31",
  };
}

interface SendResult {
  status: number;
  body: Record<string, unknown> | null;
  frames: Array<Record<string, unknown>>;
}

async function send(
  payload: unknown,
  options: { cookie?: string | null; origin?: string; raw?: string } = {},
): Promise<SendResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin) headers.origin = options.origin;
  const request = new Request(ANALYZE_URL, {
    method: "POST",
    headers,
    body: options.raw ?? JSON.stringify(payload),
  });
  const response = await POST(request);
  const text = await response.text();
  const ndjson = (response.headers.get("content-type") ?? "").includes("ndjson");
  const frames = ndjson
    ? text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];
  const body =
    ndjson || text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>);
  return { status: response.status, body, frames };
}

test("analyze: without a session the gate answers 401", async () => {
  const { status, body } = await send(validBody());
  assert.equal(status, 401);
  assert.equal(body!.code, "UNAUTHENTICATED");
});

test("analyze: cross-origin POSTs are rejected before auth", async () => {
  const { status, body } = await send(validBody(), { origin: "https://evil.example" });
  assert.equal(status, 403);
  assert.equal(body!.code, "CROSS_ORIGIN");
});

test("analyze: malformed bodies are 400 INVALID_REQUEST", async () => {
  const cookie = await ssoCookie();
  const notJson = await send(null, { cookie, raw: "{nope" });
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body!.code, "INVALID_JSON");

  const missing = await send({}, { cookie });
  assert.equal(missing.status, 400);
  assert.equal(missing.body!.code, "INVALID_REQUEST");

  const badDate = await send({ ...validBody(), fromDate: "01-10-2026" }, { cookie });
  assert.equal(badDate.status, 400);
  assert.equal(badDate.body!.code, "INVALID_REQUEST");
});

test("analyze: invalid shapes answer 400 SHAPE_INVALID with the validity object", async () => {
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
  const { status, body } = await send(
    { ...validBody(), area: { kind: "shape", geometry: outside } },
    { cookie },
  );
  assert.equal(status, 400);
  assert.equal(body!.code, "SHAPE_INVALID");
  const validity = body!.validity as { ok: boolean; reason: string };
  assert.equal(validity.ok, false);
  assert.equal(validity.reason, "outside-rajasthan");
});

test("analyze: unknown admin areas answer 404 AREA_NOT_FOUND", async () => {
  const cookie = await ssoCookie();
  const { status, body } = await send(
    { ...validBody(), area: { kind: "admin", level: "district", areaId: "d-not-real" } },
    { cookie },
  );
  assert.equal(status, 404);
  assert.equal(body!.code, "AREA_NOT_FOUND");
});

test("analyze: guests are capped at a 90-day search window", async () => {
  const cookie = await guestCookie();
  const { status, body } = await send(
    { ...validBody(), fromDate: "2026-01-01", toDate: "2026-06-01" }, // 151 days
    { cookie },
  );
  assert.equal(status, 400);
  assert.equal(body!.code, "SEARCH_WINDOW_EXCEEDED");
  assert.match(String(body!.message), /90-day/);
});

test("analyze: over-budget renders answer 413 PU_LIMIT_EXCEEDED", async () => {
  process.env.PER_ANALYSIS_PU_LIMIT = "1"; // one analysis render ≈ 4.67 PU
  const cookie = await ssoCookie();
  const { status, body } = await send(validBody(), { cookie });
  assert.equal(status, 413);
  assert.equal(body!.code, "PU_LIMIT_EXCEEDED");
  assert.match(String(body!.message), /per-analysis/);
});

test("analyze: mock source stops before the catalogue with CDSE_CONFIG", async () => {
  const cookie = await ssoCookie();
  const { status, body, frames } = await send(validBody(), { cookie });
  assert.equal(status, 400);
  assert.equal(body!.code, "CDSE_CONFIG");
  assert.match(String(body!.message), /NEXT_PUBLIC_DATA_SOURCE=cdse/);
  assert.equal(frames.length, 0, "pre-stream failures are plain JSON");
});

test("analyze: reversed date bounds are swapped, not rejected", async () => {
  const cookie = await ssoCookie();
  const { status, body } = await send(
    { ...validBody(), fromDate: "2026-10-31", toDate: "2026-10-01" },
    { cookie },
  );
  // Swapped window passes validation → reaches the mock-source gate.
  assert.equal(status, 400);
  assert.equal(body!.code, "CDSE_CONFIG");
});
