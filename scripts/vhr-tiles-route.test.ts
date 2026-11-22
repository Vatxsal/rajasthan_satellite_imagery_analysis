import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { GET as tileGet } from "../app/api/vhr/tiles/[sceneId]/[z]/[x]/[y]/route";
import { guestCookie, ssoCookie, useReadyAuthGate } from "./test-session";

/** GET /api/vhr/tiles/[sceneId]/[z]/[x]/[y] contract: vhr.view gate, tile
 *  coordinate validation, the private-bucket fetch with service-role headers
 *  (never exposed), immutable caching for hits, a verified transparent tile
 *  for gaps, and 503 when storage is unreachable. */

const REAL_FETCH = globalThis.fetch;

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

const SCENE_ID = "11111111-2222-4333-8444-555555555555";
const SERVICE_KEY = "service-role-test-key";
const TILE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EMPTY_TILE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4AWMAAQAABQABNtCI3QAAAABJRU5ErkJggg==";

let storageStatus = 200;
let storageBody: BodyInit = new Uint8Array(TILE_BYTES);
let captured: Array<{ url: string; headers: Record<string, string> }> = [];

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "10000";
  process.env.RATE_LIMIT_TILES_PER_MIN = "10000";
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
  useReadyAuthGate();

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();

  storageStatus = 200;
  storageBody = new Uint8Array(TILE_BYTES);
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
    if (url.includes("/storage/v1/object/vhr-tiles/")) {
      return new Response(storageBody, {
        status: storageStatus,
        headers: { "content-type": "image/png" },
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

function tileContext(z: string, x: string, y: string) {
  return { params: { sceneId: SCENE_ID, z, x, y } };
}

async function call(
  z: string,
  x: string,
  y: string,
  cookie?: string,
): Promise<{ status: number; body: Record<string, unknown> | null; raw: Buffer; headers: Headers }> {
  const request = new Request(
    `http://localhost/api/vhr/tiles/${SCENE_ID}/${z}/${x}/${y}`,
    { headers: cookie ? { cookie } : {} },
  );
  const response = await tileGet(request, tileContext(z, x, y));
  const raw = Buffer.from(await response.arrayBuffer());
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: response.status, body, raw, headers: response.headers };
}

test("tiles: 401 without a session", async () => {
  const result = await call("15", "24000", "15000");
  assert.equal(result.status, 401);
  assert.equal(result.body?.code, "UNAUTHENTICATED");
});

test("tiles: guests are forbidden (vhr.view is SSO-only)", async () => {
  const result = await call("15", "24000", "15000", await guestCookie());
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body?.code, "FORBIDDEN_ROLE");
  assert.equal(result.body?.required, "sso");
});

test("tiles: invalid scene id or coordinates are 400", async () => {
  const cookie = await ssoCookie();
  const badScene = new Request("http://localhost/api/vhr/tiles/not-a-uuid/15/1/1", {
    headers: { cookie },
  });
  const badSceneResult = await tileGet(badScene, {
    params: { sceneId: "not-a-uuid", z: "15", x: "1", y: "1" },
  });
  assert.equal(badSceneResult.status, 400);
  const badSceneBody = (await badSceneResult.json()) as Record<string, unknown>;
  assert.equal(badSceneBody.code, "INVALID_SCENE");

  assert.equal((await call("23", "1", "1", cookie)).status, 400);
  assert.equal((await call("15", "999999", "1", cookie)).status, 400);
  assert.equal((await call("15", "1", "-5", cookie)).status, 400);
});

test("tiles: 503 STORAGE_UNAVAILABLE without storage env", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;

  const result = await call("15", "24000", "15000", await ssoCookie());
  assert.equal(result.status, 503);
  assert.equal(result.body?.code, "SUPABASE_NOT_CONFIGURED");
});

test("tiles: hit returns the PNG with immutable private caching", async () => {
  const result = await call("15", "24000", "15000", await ssoCookie());
  assert.equal(result.status, 200);
  assert.deepEqual(result.raw, TILE_BYTES);
  assert.equal(result.headers.get("content-type"), "image/png");
  assert.equal(result.headers.get("cache-control"), "private, max-age=31536000, immutable");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("x-tile-skip"), null);

  assert.equal(captured.length, 1);
  const wire = captured[0]!;
  assert.ok(wire.url.includes(`/storage/v1/object/vhr-tiles/${SCENE_ID}/15/24000/15000`));
  assert.equal(wire.headers.apikey, SERVICE_KEY);
  assert.equal(wire.headers.authorization, `Bearer ${SERVICE_KEY}`);
  // The client response never echoes the key or the storage URL.
  assert.equal(result.body, null, "tile hits are image bytes, not JSON");
  assert.doesNotMatch(JSON.stringify({ raw: result.raw.subarray(0, 16) }), new RegExp(SERVICE_KEY));
});

test("tiles: missing tile serves a short-cached transparent PNG", async () => {
  storageStatus = 404;
  storageBody = "";
  const result = await call("15", "24000", "15000", await ssoCookie());
  assert.equal(result.status, 200);
  assert.deepEqual(result.raw, Buffer.from(EMPTY_TILE_BASE64, "base64"));
  assert.equal(result.headers.get("cache-control"), "private, max-age=600");
  assert.equal(result.headers.get("x-tile-skip"), "not-found");
  assert.equal(result.body, null, "the gap tile is image bytes, not JSON");
});

test("tiles: storage outage is 503 without upstream detail", async () => {
  storageStatus = 500;
  storageBody = JSON.stringify({ message: "internal boom" });
  const result = await call("15", "24000", "15000", await ssoCookie());
  assert.equal(result.status, 503);
  assert.equal(result.body?.code, "STORAGE_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(result.body), /boom|supabase\.test/);
});
