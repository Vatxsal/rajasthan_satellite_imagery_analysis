import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads
import "./cdse-test-env"; // then flip to live-CDSE mode before lib/dataSource freezes

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { feature, pointOnFeature, polygon } from "@turf/turf";
import { POST } from "../app/api/shapes/analyze/route";
import { districtsFc } from "../lib/data/boundaries";
import { estimateRenderPu } from "../lib/analysis/pu";
import { bboxFromGeometry, computeOutputSize } from "../lib/cdse/geometry";
import { ANALYSIS_INPUT_BANDS, ANALYZE_MAX_PX } from "../lib/draw/constants";
import { ssoCookie, useReadyAuthGate } from "./test-session";

/** NDJSON stream contract for POST /api/shapes/analyze in cdse mode. Every
 *  network dependency is stubbed (token → catalogue → Process) and the
 *  geotiff decode is injected through the alias-hook override, so the full
 *  render → stats → result pipeline runs over synthetic rasters without a
 *  single byte leaving the process. */

const ANALYZE_URL = "http://localhost/api/shapes/analyze";
const REAL_FETCH = globalThis.fetch;

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

interface FetchCall {
  url: string;
  body: string;
}

let fetchCalls: FetchCall[] = [];
let processFail = false;

/** 16 synthetic pixels: 10 clear vegetation, 2 cloudy, 4 nodata. */
const NDVI = new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.99, 0.5, -9999, -9999, -9999, -9999]);
const SCL = new Float32Array([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 9, 8, 0, 0, 0, 0]);

function stubFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  fetchCalls.push({ url, body: String(init?.body ?? "") });

  if (url.includes("openid-connect/token")) {
    return Promise.resolve(
      Response.json({ access_token: "test-token", expires_in: 600 }),
    );
  }
  if (url.includes("/catalog/v1/search")) {
    return Promise.resolve(
      Response.json({
        features: [
          {
            id: "S2A-older",
            bbox: [75.5, 26.9, 75.6, 27.0],
            properties: {
              datetime: "2026-10-05T10:30:00Z",
              "eo:cloud_cover": 12.5,
              platform: "sentinel-2a",
            },
          },
          {
            id: "S2B-newest-tie",
            bbox: [75.5, 26.9, 75.6, 27.0],
            properties: {
              datetime: "2026-10-15T10:30:00Z",
              "eo:cloud_cover": 3.2,
              platform: "sentinel-2b",
            },
          },
          {
            id: "S2A-oldest-tie",
            bbox: [75.5, 26.9, 75.6, 27.0],
            properties: {
              datetime: "2026-10-01T10:30:00Z",
              "eo:cloud_cover": 3.2,
              platform: "sentinel-2a",
            },
          },
        ],
      }),
    );
  }
  if (url.includes("/api/v1/process")) {
    if (processFail) {
      return Promise.resolve(new Response("boom", { status: 500 }));
    }
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { status: 200 }));
  }
  return Promise.reject(new Error(`unexpected fetch: ${url}`));
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

  fetchCalls = [];
  processFail = false;
  globalThis.fetch = stubFetch as typeof fetch;
  (
    globalThis as { __rseGeotiffDecode?: (ab: ArrayBuffer) => Promise<unknown> }
  ).__rseGeotiffDecode = async () => ({
    getImage: async () => ({
      getWidth: () => 4,
      getHeight: () => 4,
      readRasters: async () => [NDVI, SCL],
    }),
  });
}

beforeEach(resetState);
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  delete (globalThis as { __rseGeotiffDecode?: unknown }).__rseGeotiffDecode;
});

/** Small square (~17 km²) inside Rajasthan. */
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
    area: { kind: "shape", geometry: rajasthanSquare(), name: "Stream shape" },
    fromDate: "2026-10-01",
    toDate: "2026-10-31",
  };
}

interface SendResult {
  status: number;
  body: Record<string, unknown> | null;
  frames: Array<Record<string, unknown>>;
}

async function send(payload: unknown): Promise<SendResult> {
  const cookie = await ssoCookie();
  const request = new Request(ANALYZE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(payload),
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

test("analyze stream: stages then the least-cloudy scene's stats", async () => {
  const shape = rajasthanSquare();
  const { status, body, frames } = await send({
    area: { kind: "shape", geometry: shape, name: "Stream shape" },
    fromDate: "2026-10-01",
    toDate: "2026-10-31",
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(frames.length, 3);

  assert.deepEqual(frames[0], { type: "stage", stage: "render" });
  assert.deepEqual(frames[1], { type: "stage", stage: "stats" });

  const result = frames[2]!;
  assert.equal(result.type, "result");
  // Tie on 3.2% cloud → newest date wins.
  assert.equal(result.date, "2026-10-15");
  assert.equal(result.cloudCover, 3.2);
  assert.equal(result.satellite, "sentinel-2b");
  assert.match(String(result.areaId), /^shape:[0-9a-f]{16}$/);

  // The PU rides the pure pre-flight formula over this shape's output grid.
  const bbox = bboxFromGeometry(shape);
  assert.ok(bbox);
  const { width, height } = computeOutputSize(bbox, ANALYZE_MAX_PX);
  const expectedPu = estimateRenderPu({
    width,
    height,
    inputBands: ANALYSIS_INPUT_BANDS,
    float: true,
    samples: 1,
  });
  assert.ok(Math.abs(Number(result.pu) - expectedPu) < 1e-9, `pu=${result.pu}`);

  const metrics = result.metrics as { areaM2: number; vertices: number };
  assert.ok(metrics.areaM2 > 0 && metrics.areaM2 < 100 * 1e6);
  assert.equal(metrics.vertices, 4);

  const stats = result.stats as {
    pixels: { total: number; valid: number; clear: number; cloudy: number; nodata: number };
    ndvi: { count: number; mean: number; min: number; max: number } | null;
    scl: { vegetation: number; cloud: number; water: number } | null;
  };
  assert.deepEqual(stats.pixels, { total: 16, valid: 12, clear: 10, cloudy: 2, nodata: 4 });
  assert.equal(stats.ndvi!.count, 10);
  assert.equal(stats.ndvi!.mean, 0.45); // 0 … 0.9 over the clear pixels
  assert.equal(stats.ndvi!.min, 0);
  assert.equal(stats.ndvi!.max, 0.9);
  assert.equal(stats.scl!.vegetation, 83.3); // 10 / 12
  assert.equal(stats.scl!.cloud, 16.7); // 2 / 12

  // The catalogue saw the client's date window; one Process render happened.
  const catalog = fetchCalls.find((call) => call.url.includes("/catalog/v1/search"));
  assert.ok(catalog, "catalogue searched");
  assert.match(catalog.body, /2026-10-01T00:00:00Z\/2026-10-31T23:59:59Z/);
  assert.equal(
    fetchCalls.filter((call) => call.url.includes("/api/v1/process")).length,
    1,
  );
});

test("analyze stream: an empty catalogue answers 400 NO_SCENES pre-stream", async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    fetchCalls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("openid-connect/token")) {
      return Response.json({ access_token: "test-token", expires_in: 600 });
    }
    if (url.includes("/catalog/v1/search")) return Response.json({ features: [] });
    return Promise.reject(new Error(`unexpected fetch: ${url}`));
  }) as typeof fetch;

  const { status, body, frames } = await send(validBody());
  assert.equal(status, 400);
  assert.equal(body!.code, "NO_SCENES");
  assert.equal(frames.length, 0, "pre-stream failures are plain JSON");
});

test("analyze stream: a Process failure streams [stage render, error]", async () => {
  processFail = true;
  const { status, body, frames } = await send(validBody());
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { type: "stage", stage: "render" });
  assert.equal(frames[1]!.type, "error");
  assert.equal(frames[1]!.code, "CDSE_UPSTREAM");
  assert.match(String(frames[1]!.message), /boom/);
});
