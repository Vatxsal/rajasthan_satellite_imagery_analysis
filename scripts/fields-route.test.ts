import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { POST } from "../app/api/fields/route";
import { fieldsCache, fieldsCacheKey } from "../lib/cache";
import type { BBox } from "../lib/data/types";
import type { FieldFeature, FieldsRawEntry } from "../lib/fields/query";
import { ssoCookie, useReadyAuthGate } from "./test-session";

/** Route-level guard flow for POST /api/fields. Every test stops before a real
 *  PMTiles/COG read: guard failures answer first, cache hits answer from the
 *  seeded LRU, and a cache miss hits a fetch stub that records the attempt and
 *  fails immediately — so a regression that reaches the network fails loudly
 *  instead of waiting on data.source.coop.
 *  The auth gate is "ready" and every request carries an SSO session cookie
 *  (fields are an SSO-only capability — see lib/auth/permissions.ts). */

const FIELDS_URL = "http://localhost/api/fields";
const REAL_FETCH = globalThis.fetch;
const fetchCalls: string[] = [];

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "1000";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.org";
  useReadyAuthGate();
  delete process.env.FIELDS_ENABLED;
  delete process.env.FIELDS_MIN_CONFIDENCE;
  delete process.env.FIELDS_MAX_KM2;
  delete process.env.FIELDS_MAX_COUNT;
  delete process.env.FTW_PMTILES_URL;
  delete process.env.FTW_CONFIDENCE_COG_URL;

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();

  fetchCalls.length = 0;
  globalThis.fetch = (async (input: unknown) => {
    fetchCalls.push(String(input));
    throw new Error("network disabled in tests");
  }) as typeof fetch;
}

beforeEach(resetState);
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

async function sendFields(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const cookie = await ssoCookie();
  const request = new Request(FIELDS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...headers },
    body: JSON.stringify(payload),
  });
  return POST(request).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    headers: response.headers,
  }));
}

/** 16.5 km² at 27°N — comfortably inside the 25 km² default limit. */
const SELECTION: BBox = [75.5, 26.9, 75.55, 26.93];

function enabled(): void {
  process.env.FIELDS_ENABLED = "true";
}

function makeFeature(areaM2: number, confidence: number | null, lng: number): FieldFeature {
  return {
    type: "Feature",
    id: `f-${areaM2}`,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [lng, 26.9],
          [lng + 0.01, 26.9],
          [lng + 0.01, 26.91],
          [lng, 26.91],
          [lng, 26.9],
        ],
      ],
    },
    properties: { areaM2, confidence },
  };
}

function makeEntry(bbox: BBox, year: 2024 | 2025): FieldsRawEntry {
  return {
    bbox,
    year,
    confidenceAvailable: true,
    features: [
      makeFeature(90_000, 95, 75.5),
      makeFeature(40_000, 60, 75.52),
      makeFeature(12_000, null, 75.54),
    ],
  };
}

function seed(entry: FieldsRawEntry): void {
  fieldsCache.set(fieldsCacheKey({ bbox: entry.bbox, year: entry.year }), entry, 3600);
}

test("cross-origin POSTs are rejected before any other work", async () => {
  const { status, body } = await sendFields(
    { bbox: SELECTION, year: 2024 },
    { origin: "https://evil.example" },
  );
  assert.equal(status, 403);
  assert.equal(body.code, "CROSS_ORIGIN");
  assert.equal(fetchCalls.length, 0);
});

test("disabled deployments answer 404 FIELDS_DISABLED without touching the data source", async () => {
  process.env.FIELDS_ENABLED = "false";
  const { status, body } = await sendFields({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 404);
  assert.equal(body.code, "FIELDS_DISABLED");
  assert.match(String(body.message), /not enabled/);
  assert.equal(fetchCalls.length, 0);
});

test("malformed JSON is rejected with INVALID_JSON", async () => {
  enabled();
  const request = new Request(FIELDS_URL, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: await ssoCookie() },
    body: "not-json{{",
  });
  const response = await POST(request);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, "INVALID_JSON");
  assert.equal(fetchCalls.length, 0);
});

test("an inverted bbox fails the schema refine", async () => {
  enabled();
  const { status, body } = await sendFields({ bbox: [75.55, 26.9, 75.5, 26.93], year: 2024 });
  assert.equal(status, 400);
  assert.equal(body.code, "INVALID_REQUEST");
  assert.match(String(body.message), /west < east/);
  assert.equal(fetchCalls.length, 0);
});

test("an unsupported year fails the schema refine", async () => {
  enabled();
  const { status, body } = await sendFields({ bbox: SELECTION, year: 2023 });
  assert.equal(status, 400);
  assert.equal(body.code, "INVALID_REQUEST");
  assert.match(String(body.message), /2024 or 2025/);
  assert.equal(fetchCalls.length, 0);
});

test("an oversized selection is rejected with AREA_TOO_LARGE before any read", async () => {
  enabled();
  const { status, body } = await sendFields({ bbox: [68, 23, 78, 31], year: 2024 });
  assert.equal(status, 400);
  assert.equal(body.code, "AREA_TOO_LARGE");
  assert.match(String(body.message), /limit is 25 km²/);
  assert.equal(fetchCalls.length, 0);
});

test("a cache miss reaches the data source and surfaces failures as 503", async () => {
  enabled();
  const { status, body } = await sendFields({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 503);
  assert.equal(body.code, "FIELDS_UNAVAILABLE");
  assert.match(String(body.message), /unreachable/);
  assert.ok(fetchCalls.length >= 1, "the range reader attempted a read");
  assert.match(fetchCalls[0]!, /^https:\/\/data\.source\.coop\//);
});

test("a cached selection answers without touching the data source", async () => {
  enabled();
  seed(makeEntry(SELECTION, 2024));
  const { status, body, headers } = await sendFields({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 200);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(body).sort(), [
    "bbox",
    "confidenceAvailable",
    "count",
    "excluded",
    "fields",
    "minConfidence",
    "selectedAreaKm2",
    "totalAreaM2",
    "truncated",
    "year",
  ]);
  assert.equal(body.year, 2024);
  assert.equal(body.minConfidence, 69);
  assert.equal(body.confidenceAvailable, true);
  assert.equal(body.count, 1);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.excluded, { confidence: 1, noConfidence: 1 });
  assert.equal(body.totalAreaM2, 90_000);
  assert.ok(Math.abs(Number(body.selectedAreaKm2) - 16.46) < 0.05, "selectedAreaKm2");
  const fields = body.fields as { type: string; features: Array<{ properties: { areaM2: number } }> };
  assert.equal(fields.type, "FeatureCollection");
  assert.equal(fields.features.length, 1);
  assert.equal(fields.features[0]!.properties.areaM2, 90_000);
  assert.equal(fetchCalls.length, 0, "cache hit never reads the network");
});

test("minConfidence 0 keeps fields with unknown confidence", async () => {
  enabled();
  seed(makeEntry(SELECTION, 2024));
  const { status, body } = await sendFields({ bbox: SELECTION, year: 2024, minConfidence: 0 });
  assert.equal(status, 200);
  assert.equal(body.minConfidence, 0);
  assert.equal(body.count, 3);
  assert.deepEqual(body.excluded, { confidence: 0, noConfidence: 0 });
  assert.equal(body.totalAreaM2, 142_000);
});

test("the per-response cap reports truncated with counters intact", async () => {
  enabled();
  process.env.FIELDS_MAX_COUNT = "1";
  seed(makeEntry(SELECTION, 2024));
  const { status, body } = await sendFields({
    bbox: SELECTION,
    year: 2024,
    minConfidence: 0, // every feature qualifies → the cap (not the threshold) truncates
  });
  assert.equal(status, 200);
  assert.equal(body.count, 1);
  assert.equal(body.truncated, true);
  assert.deepEqual(body.excluded, { confidence: 0, noConfidence: 0 });
  assert.equal(body.totalAreaM2, 90_000);
});

test("FIELDS_MIN_CONFIDENCE applies when the body omits the threshold", async () => {
  enabled();
  process.env.FIELDS_MIN_CONFIDENCE = "80";
  seed(makeEntry(SELECTION, 2024));
  const { status, body } = await sendFields({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 200);
  assert.equal(body.minConfidence, 80);
  assert.equal(body.count, 1);
  assert.deepEqual(body.excluded, { confidence: 1, noConfidence: 1 });
});

test("a string year is coerced and keys the cache like a numeric year", async () => {
  enabled();
  seed(makeEntry(SELECTION, 2025));
  const { status, body } = await sendFields({ bbox: SELECTION, year: "2025" });
  assert.equal(status, 200);
  assert.equal(body.year, 2025);
  assert.equal(typeof body.year, "number");
  assert.equal(fetchCalls.length, 0);
});

test("the rate limiter answers 429 with Retry-After", async () => {
  process.env.FIELDS_ENABLED = "false";
  process.env.RATE_LIMIT_PER_MIN = "1";
  const first = await sendFields({ bbox: SELECTION, year: 2024 });
  assert.equal(first.status, 404); // passed the guard, stopped at FIELDS_DISABLED
  const second = await sendFields({ bbox: SELECTION, year: 2024 });
  assert.equal(second.status, 429);
  assert.equal(second.body.code, "RATE_LIMITED");
  const retryAfter = Number(second.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, "Retry-After header");
  assert.equal(fetchCalls.length, 0);
});
