import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { POST as analyzePost } from "../app/api/compare/analyze/route";
import { GET as eventsGet } from "../app/api/compare/events/route";
import { POST as emailPost } from "../app/api/compare/email/route";
import { GET as overlayGet } from "../app/api/compare/overlay/route";
import { POST as summaryPost } from "../app/api/compare/summary/route";
import { POST as fieldsPost } from "../app/api/fields/route";
import { POST as patternPost } from "../app/api/fields/pattern/route";
import { GET as imageryGet } from "../app/api/imagery/route";
import { POST as scenesPost } from "../app/api/scenes/route";
import { GET as tilesGet } from "../app/api/tiles/[z]/[x]/[y]/route";
import { limitsFor } from "../lib/auth/permissions";
import { consumeQuota, resetRoleQuotas, type QuotaKind } from "../lib/auth/quota";
import { guestCookie, ssoCookie, useOpenAuthGate, useReadyAuthGate } from "./test-session";

/** Role enforcement with RAW requests (no UI): every protected route answers
 *  401 without a session, 403 FORBIDDEN_ROLE when the role lacks a
 *  capability or is past a numeric cap, and 429 + Retry-After when a daily
 *  role quota is spent. The mock data source keeps everything offline —
 *  "past all guards" surfaces as the route's upstream/sentinel error.
 *  All counters are per UTC day on globalThis (reset between tests). */

const REAL_FETCH = globalThis.fetch;

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "10000";
  process.env.RATE_LIMIT_TILES_PER_MIN = "10000";
  process.env.COMPARE_RATE_LIMIT_PER_MIN = "10000";
  process.env.AI_SUMMARY_RATE_LIMIT_PER_MIN = "10000";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.org";
  process.env.EMAIL_PROVIDER = "console";
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.EMAIL_FIXED_RECIPIENT;
  delete process.env.FIELDS_ENABLED;
  useReadyAuthGate();

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();
  resetRoleQuotas();

  globalThis.fetch = (async () => {
    throw new Error("network disabled in tests");
  }) as typeof fetch;
}

beforeEach(resetState);
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

async function call(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- route handlers carry their own context shapes
  handler: (request: Request, context?: any) => Promise<Response>,
  request: Request,
  context?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null; headers: Headers }> {
  const response = await handler(request, context);
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

function post(url: string, payload: unknown, cookie?: string): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(payload),
  });
}

function get(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

function assertUnauthenticated(result: { status: number; body: Record<string, unknown> | null }): void {
  assert.equal(result.status, 401);
  assert.equal(result.body?.code, "UNAUTHENTICATED");
}

function assertForbiddenSso(result: { status: number; body: Record<string, unknown> | null }): void {
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body?.code, "FORBIDDEN_ROLE");
  assert.equal(result.body?.message, "Sign in with an SSO ID to use this");
  assert.equal(result.body?.required, "sso");
}

function assertQuota(result: { status: number; body: Record<string, unknown> | null; headers: Headers }): void {
  assert.equal(result.status, 429, JSON.stringify(result.body));
  assert.equal(result.body?.code, "ROLE_QUOTA_EXCEEDED");
  const retryAfter = Number(result.headers.get("Retry-After"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, `Retry-After=${retryAfter}`);
}

/** Burns a whole daily budget for the subject (both scopes), like N requests. */
function exhaustQuota(kind: QuotaKind, sub: string, limit: number): void {
  const subject = { sub, ip: "local" }; // no x-forwarded-for → "local"
  for (let i = 0; i < limit; i += 1) consumeQuota(kind, subject, limit);
}

const VALID_KEY = "a".repeat(64);

// ---------------------------------------------------------------- scenes

const SCENES_URL = "http://localhost/api/scenes";
const SCENES_BODY = {
  districtId: "d-jaisalmer",
  fromDate: "2026-09-01",
  toDate: "2026-09-30",
  maxCloudCover: 20,
  composite: "true-color",
};

test("scenes: 401 without a session", async () => {
  const result = await call(scenesPost, post(SCENES_URL, SCENES_BODY));
  assertUnauthenticated(result);
});

test("scenes: guest search window beyond 90 days is rejected", async () => {
  const cookie = await guestCookie();
  const result = await call(
    scenesPost,
    post(SCENES_URL, { ...SCENES_BODY, fromDate: "2025-01-01", toDate: "2026-09-30" }, cookie),
  );
  assert.equal(result.status, 400);
  assert.equal(result.body?.code, "SEARCH_WINDOW_EXCEEDED");
  assert.match(String(result.body?.message), /90-day window/);
});

test("scenes: SSO searches the full archive window", async () => {
  const cookie = await ssoCookie();
  const result = await call(
    scenesPost,
    post(SCENES_URL, { ...SCENES_BODY, fromDate: "2025-01-01", toDate: "2026-09-30" }, cookie),
  );
  // Past window + quota → catalogue fetch fails offline: NOT a role error.
  assert.notEqual(result.status, 400);
  assert.notEqual(result.status, 401);
  assert.notEqual(result.status, 403);
  assert.notEqual(result.status, 429);
});

test("scenes: guest daily search quota answers 429 with Retry-After", async () => {
  const sub = "guest:search-quota";
  exhaustQuota("search", sub, limitsFor("guest").searchesPerDay);
  const result = await call(scenesPost, post(SCENES_URL, SCENES_BODY, await guestCookie(sub)));
  assertQuota(result);
});

test("scenes: the IP scope blocks a fresh guest session after exhaustion", async () => {
  exhaustQuota("search", "guest:first", limitsFor("guest").searchesPerDay);
  const result = await call(scenesPost, post(SCENES_URL, SCENES_BODY, await guestCookie("guest:second")));
  assertQuota(result);
});

test("scenes: SSO is not blocked by the guest IP budget", async () => {
  exhaustQuota("search", "guest:first", limitsFor("guest").searchesPerDay);
  const result = await call(scenesPost, post(SCENES_URL, SCENES_BODY, await ssoCookie()));
  // 300/day SSO vs 30 spent on this IP → passes the quota, fails offline.
  assert.notEqual(result.status, 429);
  assert.notEqual(result.status, 401);
  assert.notEqual(result.status, 403);
});

// ---------------------------------------------------------------- tiles

const TILE_QUERY = "date=2026-01-01&areaId=d-jaisalmer&level=district";

async function tile(z: number, x: number, y: number, cookie?: string) {
  return call(
    tilesGet,
    get(`http://localhost/api/tiles/${z}/${x}/${y}.png?${TILE_QUERY}`, cookie),
    { params: { z: String(z), x: String(x), y: String(y) } },
  );
}

test("tiles: 401 without a session", async () => {
  assertUnauthenticated(await tile(12, 0, 0));
});

test("tiles: guest is refused above z12 with FORBIDDEN_ROLE", async () => {
  const cookie = await guestCookie();
  const result = await tile(13, 0, 0, cookie);
  assertForbiddenSso(result);
});

test("tiles: guest is served inside the band up to z12", async () => {
  const result = await tile(12, 0, 0, await guestCookie());
  // Tile far outside Rajasthan → empty tile, no Process API call.
  assert.equal(result.status, 200);
});

test("tiles: SSO is served above the guest cap (z13)", async () => {
  const result = await tile(13, 0, 0, await ssoCookie());
  assert.equal(result.status, 200);
});

test("tiles: the SSO cap itself holds at z15", async () => {
  const result = await tile(15, 0, 0, await ssoCookie());
  assertForbiddenSso(result);
});

// ---------------------------------------------------------------- imagery

const IMAGERY_URL =
  "http://localhost/api/imagery?districtId=d-jaisalmer&date=2026-01-01&composite=true-color";

test("imagery: 401 without a session", async () => {
  assertUnauthenticated(await call(imageryGet, get(`${IMAGERY_URL}&size=160&format=png`)));
});

test("imagery: guest GeoTIFF is a missing capability", async () => {
  const result = await call(
    imageryGet,
    get(`${IMAGERY_URL}&size=512&format=tiff`, await guestCookie()),
  );
  assertForbiddenSso(result);
});

test("imagery: guest PNG is capped at 1024 px", async () => {
  const result = await call(
    imageryGet,
    get(`${IMAGERY_URL}&size=2048&format=png`, await guestCookie()),
  );
  assert.equal(result.status, 400);
  assert.equal(result.body?.code, "DOWNLOAD_TOO_LARGE");
  assert.match(String(result.body?.message), /1024×1024/);
});

test("imagery: SSO PNG renders up to 1024 too, GeoTIFF up to 2500", async () => {
  const over = await call(
    imageryGet,
    get(`${IMAGERY_URL}&size=3000&format=tiff`, await ssoCookie()),
  );
  assert.equal(over.status, 400);
  assert.equal(over.body?.code, "DOWNLOAD_TOO_LARGE");
  assert.match(String(over.body?.message), /2500×2500/);

  // Within both caps: format + size accepted (render fails offline → ≥500).
  const ok = await call(imageryGet, get(`${IMAGERY_URL}&size=512&format=tiff`, await ssoCookie()));
  assert.ok(ok.status === 200 || ok.status >= 500, `got ${ok.status}`);
});

// ---------------------------------------------------------------- compare analyze

const ANALYZE_URL = "http://localhost/api/compare/analyze";
const ANALYZE_BODY = {
  areaId: "d-jaisalmer",
  level: "tehsil",
  dateA: "2026-01-01",
  dateB: "2026-01-20",
};

test("analyze: 401 without a session", async () => {
  assertUnauthenticated(await call(analyzePost, post(ANALYZE_URL, ANALYZE_BODY)));
});

test("analyze: guest district level is FORBIDDEN_ROLE", async () => {
  const result = await call(
    analyzePost,
    post(ANALYZE_URL, { ...ANALYZE_BODY, level: "district" }, await guestCookie()),
  );
  assertForbiddenSso(result);
});

test("analyze: guest runs tehsil comparisons (reaches the mock-source sentinel)", async () => {
  const result = await call(analyzePost, post(ANALYZE_URL, ANALYZE_BODY, await guestCookie()));
  assert.equal(result.status, 400);
  assert.equal(result.body?.code, "CDSE_CONFIG");
});

test("analyze: guest tuning parameters are clamped, not rejected", async () => {
  const result = await call(
    analyzePost,
    post(
      ANALYZE_URL,
      { ...ANALYZE_BODY, sensitivity: "high", minPatchHa: 7 },
      await guestCookie(),
    ),
  );
  assert.equal(result.status, 400);
  assert.equal(result.body?.code, "CDSE_CONFIG");
});

test("analyze: SSO may compare at district level", async () => {
  const result = await call(
    analyzePost,
    post(ANALYZE_URL, { ...ANALYZE_BODY, level: "district" }, await ssoCookie()),
  );
  assert.equal(result.status, 400);
  assert.equal(result.body?.code, "CDSE_CONFIG");
});

test("analyze: guest daily compare quota answers 429 with Retry-After", async () => {
  const sub = "guest:compare-quota";
  exhaustQuota("compare", sub, limitsFor("guest").comparePerDay);
  const result = await call(analyzePost, post(ANALYZE_URL, ANALYZE_BODY, await guestCookie(sub)));
  assertQuota(result);
});

test("analyze: ambient guest (gate off) is held to the guest policy", async () => {
  useOpenAuthGate();
  const result = await call(
    analyzePost,
    post(ANALYZE_URL, { ...ANALYZE_BODY, level: "district" }),
  );
  assertForbiddenSso(result);
});

// ---------------------------------------------------------------- overlay / events

const OVERLAY_URL = `http://localhost/api/compare/overlay?key=${VALID_KEY}`;

test("overlay: 401 without a session on the plain image source", async () => {
  assertUnauthenticated(await call(overlayGet, get(`${OVERLAY_URL}&format=png`)));
});

test("overlay: guest GeoTIFF export is FORBIDDEN_ROLE", async () => {
  const result = await call(overlayGet, get(`${OVERLAY_URL}&format=geotiff`, await guestCookie()));
  assertForbiddenSso(result);
});

test("overlay: guest PNG download flag (export button) is FORBIDDEN_ROLE", async () => {
  const result = await call(
    overlayGet,
    get(`${OVERLAY_URL}&format=png&download=1`, await guestCookie()),
  );
  assertForbiddenSso(result);
});

test("overlay: guest map display (no download flag) passes the capability", async () => {
  const result = await call(overlayGet, get(`${OVERLAY_URL}&format=png`, await guestCookie()));
  assert.equal(result.status, 404); // cache-only key → ANALYSIS_EXPIRED
  assert.equal(result.body?.code, "ANALYSIS_EXPIRED");
});

test("overlay: SSO GeoTIFF export passes the capability", async () => {
  const result = await call(overlayGet, get(`${OVERLAY_URL}&format=geotiff`, await ssoCookie()));
  assert.equal(result.status, 404);
  assert.equal(result.body?.code, "ANALYSIS_EXPIRED");
});

test("events: 401 without a session, then guest view passes", async () => {
  assertUnauthenticated(await call(eventsGet, get(`http://localhost/api/compare/events?key=${VALID_KEY}`)));
  const guest = await call(
    eventsGet,
    get(`http://localhost/api/compare/events?key=${VALID_KEY}`, await guestCookie()),
  );
  assert.equal(guest.status, 404);
  assert.equal(guest.body?.code, "ANALYSIS_EXPIRED");
});

// ---------------------------------------------------------------- summary / email

const SUMMARY_URL = "http://localhost/api/compare/summary";
const SUMMARY_BODY = { analysisKey: VALID_KEY, language: "en", includeImages: false };

test("summary: 401 without a session", async () => {
  assertUnauthenticated(await call(summaryPost, post(SUMMARY_URL, SUMMARY_BODY)));
});

test("summary: guest AI summary is FORBIDDEN_ROLE", async () => {
  const result = await call(summaryPost, post(SUMMARY_URL, SUMMARY_BODY, await guestCookie()));
  assertForbiddenSso(result);
});

test("summary: SSO passes capability + quota to the Gemini stage", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const result = await call(summaryPost, post(SUMMARY_URL, SUMMARY_BODY, await ssoCookie()));
  // No cached artifact and no params → 404 past every role/quota/gemini guard.
  assert.equal(result.status, 404);
  assert.equal(result.body?.code, "ANALYSIS_EXPIRED");
});

test("summary: SSO daily AI quota answers 429 before any Gemini work", async () => {
  exhaustQuota("aiSummary", "sso-ai-quota", limitsFor("sso").aiSummariesPerDay);
  const result = await call(
    summaryPost,
    post(SUMMARY_URL, SUMMARY_BODY, await ssoCookie("sso-ai-quota")),
  );
  assertQuota(result);
});

const EMAIL_URL = "http://localhost/api/compare/email";
const EMAIL_BODY = { email: "citizen@example.org", params: { ...ANALYZE_BODY, level: "district" } };

test("email: 401 without a session", async () => {
  assertUnauthenticated(await call(emailPost, post(EMAIL_URL, EMAIL_BODY)));
});

test("email: guest report is FORBIDDEN_ROLE", async () => {
  const result = await call(emailPost, post(EMAIL_URL, EMAIL_BODY, await guestCookie()));
  assertForbiddenSso(result);
});

// ---------------------------------------------------------------- fields

const FIELDS_BODY = { bbox: [75.5, 26.9, 75.55, 26.93], year: 2024 };

test("fields: 401 without a session when enabled", async () => {
  process.env.FIELDS_ENABLED = "true";
  assertUnauthenticated(await call(fieldsPost, post("http://localhost/api/fields", FIELDS_BODY)));
});

test("fields: guest is FORBIDDEN_ROLE", async () => {
  process.env.FIELDS_ENABLED = "true";
  const result = await call(
    fieldsPost,
    post("http://localhost/api/fields", FIELDS_BODY, await guestCookie()),
  );
  assertForbiddenSso(result);
});

test("fields: SSO passes the capability to the data stage", async () => {
  process.env.FIELDS_ENABLED = "true";
  const result = await call(
    fieldsPost,
    post("http://localhost/api/fields", FIELDS_BODY, await ssoCookie()),
  );
  assert.notEqual(result.status, 401);
  assert.notEqual(result.status, 403);
});

test("fields/pattern: guest is FORBIDDEN_ROLE, SSO passes", async () => {
  process.env.FIELDS_ENABLED = "true";
  const guest = await call(
    patternPost,
    post("http://localhost/api/fields/pattern", FIELDS_BODY, await guestCookie()),
  );
  assertForbiddenSso(guest);

  const sso = await call(
    patternPost,
    post("http://localhost/api/fields/pattern", FIELDS_BODY, await ssoCookie()),
  );
  assert.notEqual(sso.status, 401);
  assert.notEqual(sso.status, 403);
});
