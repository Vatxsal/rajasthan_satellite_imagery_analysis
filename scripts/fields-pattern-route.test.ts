import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { POST } from "../app/api/fields/pattern/route";
import {
  fieldsCache,
  fieldsCacheKey,
  patternCache,
  patternCacheKey,
} from "../lib/cache";
import { getServerEnv } from "../lib/env";
import { agriYearMonths } from "../lib/fields/pattern";
import type { PatternResult } from "../lib/fields/patternRun";
import { PATTERN_CLASSES } from "../lib/fields/config";
import type { BBox } from "../lib/data/types";
import type { FieldFeature, FieldsRawEntry } from "../lib/fields/query";
import { ssoCookie, useReadyAuthGate } from "./test-session";

/** Route-level guard flow for POST /api/fields/pattern. Every test stops before
 *  a real PMTiles/CDSE read: guard failures answer as JSON, a seeded pattern
 *  cache replays the NDJSON frame sequence, and a cache miss either fails the
 *  PU pre-flight / field build or hits a fetch stub that records the attempt
 *  and fails immediately — so a regression that reaches the network fails
 *  loudly instead of waiting on data.source.coop.
 *  The auth gate is "ready" and every request carries an SSO session cookie
 *  (fields are an SSO-only capability — see lib/auth/permissions.ts). */

const PATTERN_URL = "http://localhost/api/fields/pattern";
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
  delete process.env.FIELDS_GROUPING;
  delete process.env.FTW_PMTILES_URL;
  delete process.env.FTW_CONFIDENCE_COG_URL;
  delete process.env.COMPARE_RATE_LIMIT_PER_MIN;
  delete process.env.PER_ANALYSIS_PU_LIMIT;

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();

  fieldsCache.clear();
  patternCache.clear();

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

interface SendResult {
  status: number;
  headers: Headers;
  /** Parsed NDJSON frames (empty for plain-JSON guard answers). */
  frames: Array<Record<string, unknown>>;
  /** Parsed JSON body (null for NDJSON responses). */
  body: Record<string, unknown> | null;
}

async function send(
  payload: Record<string, unknown> | string,
  headers: Record<string, string> = {},
): Promise<SendResult> {
  const cookie = await ssoCookie();
  const request = new Request(PATTERN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  return POST(request).then(async (response) => {
    const text = await response.text();
    const ndjson = (response.headers.get("content-type") ?? "").includes("ndjson");
    const frames = ndjson
      ? text
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as Record<string, unknown>)
      : [];
    const body = ndjson || text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>);
    return { status: response.status, headers: response.headers, frames, body };
  });
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

function makeEntry(bbox: BBox, year: 2024 | 2025, confidence: number | null = 95): FieldsRawEntry {
  return {
    bbox,
    year,
    confidenceAvailable: true,
    features: [makeFeature(90_000, confidence, 75.5)],
  };
}

function seedFields(entry: FieldsRawEntry): void {
  fieldsCache.set(fieldsCacheKey({ bbox: entry.bbox, year: entry.year }), entry, 3600);
}

function seedPattern(result: PatternResult, grouping: boolean): void {
  patternCache.set(
    patternCacheKey({
      bbox: SELECTION,
      year: 2024,
      minConfidence: result.minConfidence,
      grouping,
      maxCount: getServerEnv().FIELDS_MAX_COUNT,
    }),
    result,
    3600,
  );
}

function makePatternResult(): PatternResult {
  const classes = Object.fromEntries(PATTERN_CLASSES.map((name) => [name, 0])) as PatternResult["classes"];
  classes.fallow = 1;
  return {
    bbox: SELECTION,
    year: 2024,
    minConfidence: getServerEnv().FIELDS_MIN_CONFIDENCE,
    months: agriYearMonths(2024).map((month) => month.label),
    count: 1,
    truncated: false,
    grouping: { enabled: false, k: null, sizes: [] },
    classes,
    estimatedPu: 120,
    fields: [
      { id: "f-1", cls: "fallow", group: null, series: null, validMonths: 12, metrics: null },
    ],
  };
}

// ── guards ──────────────────────────────────────────────────────────────────

test("cross-origin POSTs are rejected before any other work", async () => {
  const { status, body } = await send(
    { bbox: SELECTION, year: 2024 },
    { origin: "https://evil.example" },
  );
  assert.equal(status, 403);
  assert.equal(body?.code, "CROSS_ORIGIN");
  assert.equal(fetchCalls.length, 0);
});

test("disabled deployments answer 404 FIELDS_DISABLED without touching the data source", async () => {
  process.env.FIELDS_ENABLED = "false";
  const { status, body } = await send({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 404);
  assert.equal(body?.code, "FIELDS_DISABLED");
  assert.match(String(body?.message), /not enabled/);
  assert.equal(fetchCalls.length, 0);
});

test("malformed JSON is rejected with INVALID_JSON", async () => {
  enabled();
  const { status, body } = await send("not-json{{");
  assert.equal(status, 400);
  assert.equal(body?.code, "INVALID_JSON");
  assert.equal(fetchCalls.length, 0);
});

test("an inverted bbox fails the schema refine", async () => {
  enabled();
  const { status, body } = await send({ bbox: [75.55, 26.9, 75.5, 26.93], year: 2024 });
  assert.equal(status, 400);
  assert.equal(body?.code, "INVALID_REQUEST");
  assert.match(String(body?.message), /west < east/);
  assert.equal(fetchCalls.length, 0);
});

test("an unsupported year fails the schema refine", async () => {
  enabled();
  const { status, body } = await send({ bbox: SELECTION, year: 2023 });
  assert.equal(status, 400);
  assert.equal(body?.code, "INVALID_REQUEST");
  assert.match(String(body?.message), /2024 or 2025/);
  assert.equal(fetchCalls.length, 0);
});

test("a non-boolean grouping flag fails the schema refine", async () => {
  enabled();
  const { status, body } = await send({ bbox: SELECTION, year: 2024, grouping: "yes" });
  assert.equal(status, 400);
  assert.equal(body?.code, "INVALID_REQUEST");
  assert.equal(fetchCalls.length, 0);
});

test("an oversized selection is rejected with AREA_TOO_LARGE before any read", async () => {
  enabled();
  const { status, body } = await send({ bbox: [68, 23, 78, 31], year: 2024 });
  assert.equal(status, 400);
  assert.equal(body?.code, "AREA_TOO_LARGE");
  assert.match(String(body?.message), /limit is 25 km²/);
  assert.equal(fetchCalls.length, 0);
});

test("the PU pre-flight answers 413 before any field build or render", async () => {
  enabled();
  process.env.PER_ANALYSIS_PU_LIMIT = "1"; // 12 monthly renders of 16.5 km² far exceed 1 PU
  const { status, body } = await send({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 413);
  assert.equal(body?.code, "PU_LIMIT_EXCEEDED");
  assert.match(String(body?.message), /monthly renders/);
  assert.equal(fetchCalls.length, 0, "the pre-flight never reaches the network");
});

test("a cache miss reaches the data source and surfaces failures as 503", async () => {
  enabled();
  const { status, body } = await send({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 503);
  assert.equal(body?.code, "FIELDS_UNAVAILABLE");
  assert.match(String(body?.message), /unreachable/);
  assert.ok(fetchCalls.length >= 1, "the range reader attempted a read");
  assert.match(fetchCalls[0]!, /^https:\/\/data\.source\.coop\//);
});

test("an empty filtered selection answers NO_FIELDS without any CDSE work", async () => {
  enabled();
  seedFields(makeEntry(SELECTION, 2024, 60)); // confidence 60 < default threshold 69
  const { status, body } = await send({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 400);
  assert.equal(body?.code, "NO_FIELDS");
  assert.equal(fetchCalls.length, 0, "no imagery request before the no-fields gate");
});

test("mock-mode deployments refuse the live run with CDSE_CONFIG", async () => {
  enabled();
  seedFields(makeEntry(SELECTION, 2024, 95)); // passes the confidence filter
  const { status, body } = await send({ bbox: SELECTION, year: 2024 });
  assert.equal(status, 400);
  assert.equal(body?.code, "CDSE_CONFIG");
  assert.match(String(body?.message), /Sentinel-2/);
  assert.equal(fetchCalls.length, 0, "the mock gate sits before any render");
});

// ── cache replay ────────────────────────────────────────────────────────────

test("a cached run replays the full NDJSON frame sequence without any read", async () => {
  enabled();
  seedPattern(makePatternResult(), false);
  const { status, headers, frames, body } = await send({ bbox: SELECTION, year: 2024 });
  assert.equal(body, null, "cached runs answer as NDJSON, not JSON");
  assert.equal(status, 200);
  assert.match(headers.get("content-type") ?? "", /application\/x-ndjson/);
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("x-accel-buffering"), "no");

  assert.equal(frames.length, 16);
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["stage", "stage", ...Array.from({ length: 12 }, () => "month"), "stage", "result"],
  );
  assert.equal(frames[0]?.stage, "fields");
  assert.equal(frames[1]?.stage, "ndvi");
  assert.deepEqual(
    frames.slice(2, 14).map((frame) => frame.index),
    Array.from({ length: 12 }, (_unused, index) => index),
  );
  assert.deepEqual(
    frames.slice(2, 14).map((frame) => frame.label),
    agriYearMonths(2024).map((month) => month.label),
  );
  assert.equal(frames[14]?.stage, "analyze");
  assert.equal(frames[15]?.type, "result");
  assert.equal(frames[15]?.count, 1);
  assert.equal(fetchCalls.length, 0, "cache hit never reads the network");
});

test("the grouping flag changes the cache key", async () => {
  enabled();
  seedPattern(makePatternResult(), true); // seeded with grouping: true
  const hit = await send({ bbox: SELECTION, year: 2024, grouping: true });
  assert.equal(hit.status, 200);
  assert.equal(hit.frames.at(-1)?.type, "result");
  assert.equal(fetchCalls.length, 0);

  const miss = await send({ bbox: SELECTION, year: 2024 }); // default grouping: false
  assert.equal(miss.status, 503);
  assert.equal(miss.body?.code, "FIELDS_UNAVAILABLE", "different key → full path → fetch stub fails");
  assert.ok(fetchCalls.length >= 1);
});

// ── rate limit ──────────────────────────────────────────────────────────────

test("the compare rate limiter answers 429 with Retry-After", async () => {
  process.env.FIELDS_ENABLED = "false";
  process.env.COMPARE_RATE_LIMIT_PER_MIN = "1";
  const first = await send({ bbox: SELECTION, year: 2024 });
  assert.equal(first.status, 404); // passed the limiter, stopped at FIELDS_DISABLED
  const second = await send({ bbox: SELECTION, year: 2024 });
  assert.equal(second.status, 429);
  assert.equal(second.body?.code, "RATE_LIMITED");
  const retryAfter = Number(second.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, "Retry-After header");
  assert.equal(fetchCalls.length, 0);
});
