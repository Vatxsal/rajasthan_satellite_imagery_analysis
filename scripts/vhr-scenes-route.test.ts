import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { GET as scenesGet } from "../app/api/vhr/scenes/route";
import { guestCookie, ssoCookie, useReadyAuthGate } from "./test-session";

/** GET /api/vhr/scenes contract: vhr.view capability gate, bbox validation,
 *  Supabase configuration gate, JS-side overlap filtering, and the wire
 *  headers that carry the service-role key (which must never leak). */

const REAL_FETCH = globalThis.fetch;

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

const SCENES_URL = "http://localhost/api/vhr/scenes?bbox=72,24,77,29";
const SERVICE_KEY = "service-role-test-key";

interface FixtureRow {
  id: string;
  sensor: string;
  acquired_at: string;
  resolution_m: number;
  min_zoom: number;
  max_zoom: number;
  min_lng: number;
  min_lat: number;
  max_lng: number;
  max_lat: number;
  bands: string[];
  license_note: string | null;
}

const OVERLAPPING_ROW: FixtureRow = {
  id: "11111111-2222-4333-8444-555555555555",
  sensor: "ResourceSat-2 LISS-IV",
  acquired_at: "2026-01-15T05:30:00+00:00",
  resolution_m: 5.8,
  min_zoom: 13,
  max_zoom: 17,
  min_lng: 73.1,
  min_lat: 25.2,
  max_lng: 75.4,
  max_lat: 27.1,
  bands: ["green", "red", "nir"],
  license_note: "NRSC Bhoonidhi open data",
};

const FAR_ROW: FixtureRow = {
  id: "99999999-8888-4777-8666-555555555555",
  sensor: "ResourceSat-2A LISS-IV",
  acquired_at: "2026-02-01T05:30:00+00:00",
  resolution_m: 5.8,
  min_zoom: 13,
  max_zoom: 17,
  min_lng: 88.0,
  min_lat: 22.0,
  max_lng: 89.0,
  max_lat: 23.0,
  bands: ["green", "red", "nir"],
  license_note: null,
};

let fixtureRows: FixtureRow[] = [];
let storageStatus = 200;
let captured: Array<{ url: string; headers: Record<string, string> }> = [];

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "10000";
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  useReadyAuthGate();

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();

  fixtureRows = [OVERLAPPING_ROW, FAR_ROW];
  storageStatus = 200;
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) raw.forEach((value, key) => (headers[key.toLowerCase()] = value));
    else if (raw) {
      for (const [key, value] of Object.entries(raw as Record<string, string | undefined>)) {
        if (value !== undefined) headers[key.toLowerCase()] = value;
      }
    }
    captured.push({ url, headers });
    if (url.includes("/rest/v1/vhr_scenes")) {
      if (storageStatus !== 200) {
        return new Response(JSON.stringify({ message: "boom" }), { status: storageStatus });
      }
      return new Response(JSON.stringify(fixtureRows), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unexpected URL", { status: 404 });
  }) as typeof fetch;
}

beforeEach(resetState);
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route handlers carry their own context shapes
type Handler = (request: Request, context?: any) => Promise<Response>;

async function call(
  handler: Handler,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await handler(request);
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body };
}

function get(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

test("scenes: 401 without a session", async () => {
  const result = await call(scenesGet, get(SCENES_URL));
  assert.equal(result.status, 401);
  assert.equal(result.body?.code, "UNAUTHENTICATED");
});

test("scenes: guests are forbidden (vhr.view is SSO-only)", async () => {
  const result = await call(scenesGet, get(SCENES_URL, await guestCookie()));
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body?.code, "FORBIDDEN_ROLE");
  assert.equal(result.body?.required, "sso");
});

test("scenes: missing or malformed bbox is 400", async () => {
  const missing = await call(scenesGet, get("http://localhost/api/vhr/scenes", await ssoCookie()));
  assert.equal(missing.status, 400);
  assert.equal(missing.body?.code, "INVALID_REQUEST");

  const malformed = await call(
    scenesGet,
    get("http://localhost/api/vhr/scenes?bbox=1,2,3", await ssoCookie()),
  );
  assert.equal(malformed.status, 400);

  const inverted = await call(
    scenesGet,
    get("http://localhost/api/vhr/scenes?bbox=77,29,72,24", await ssoCookie()),
  );
  assert.equal(inverted.status, 400);
});

test("scenes: 503 SUPABASE_NOT_CONFIGURED without storage env", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;

  const result = await call(scenesGet, get(SCENES_URL, await ssoCookie()));
  assert.equal(result.status, 503);
  assert.equal(result.body?.code, "SUPABASE_NOT_CONFIGURED");
});

test("scenes: SSO gets overlapping scenes with service-role wire headers", async () => {
  const result = await call(scenesGet, get(SCENES_URL, await ssoCookie()));
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const scenes = result.body?.scenes as Array<Record<string, unknown>>;
  assert.equal(scenes.length, 1, "only the overlapping scene is returned");
  assert.equal(scenes[0]?.id, OVERLAPPING_ROW.id);
  assert.equal(scenes[0]?.sensor, "ResourceSat-2 LISS-IV");
  assert.equal(scenes[0]?.resolutionM, 5.8);
  assert.deepEqual(scenes[0]?.bbox, [73.1, 25.2, 75.4, 27.1]);
  assert.deepEqual(scenes[0]?.bands, ["green", "red", "nir"]);
  assert.equal(scenes[0]?.licenseNote, "NRSC Bhoonidhi open data");

  // The list route hits PostgREST with the service-role credentials…
  assert.equal(captured.length, 1);
  const wire = captured[0]!;
  assert.ok(wire.url.includes("/rest/v1/vhr_scenes"));
  assert.equal(wire.headers.apikey, SERVICE_KEY);
  assert.equal(wire.headers.authorization, `Bearer ${SERVICE_KEY}`);

  // …and the response never echoes them.
  assert.doesNotMatch(JSON.stringify(result.body), new RegExp(SERVICE_KEY));
});

test("scenes: null license_note serialises as an empty string", async () => {
  fixtureRows = [FAR_ROW];
  // Force the FAR row into view by asking for its bbox.
  const result = await call(
    scenesGet,
    get("http://localhost/api/vhr/scenes?bbox=87,21,90,24", await ssoCookie()),
  );
  assert.equal(result.status, 200);
  const scenes = result.body?.scenes as Array<Record<string, unknown>>;
  assert.equal(scenes.length, 1);
  assert.equal(scenes[0]?.licenseNote, "");
});

test("scenes: storage outage maps to 503 without upstream detail", async () => {
  storageStatus = 500;
  const result = await call(scenesGet, get(SCENES_URL, await ssoCookie()));
  assert.equal(result.status, 503);
  assert.equal(result.body?.code, "STORAGE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result.body), /supabase\.test|boom/);
});
