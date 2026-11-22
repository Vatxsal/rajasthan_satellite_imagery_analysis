import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { POST as requestPost } from "../app/api/vhr/request/route";
import { resetAccessRequestState } from "../lib/server/accessRequest";
import { PREVIEW_DIR_NAME } from "../lib/email/providers/console";
import { guestCookie, ssoCookie, useReadyAuthGate } from "./test-session";

/** POST /api/vhr/request contract: origin gate, session gate, AOI/date
 *  validation, honeypot fake success, availability gate, duplicate
 *  suppression, shared daily quota, and the console email (subject + AOI
 *  attachment) — all offline via EMAIL_PROVIDER=console. */

const REAL_FETCH = globalThis.fetch;

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

const FIXED_RECIPIENT = "qa.vhr@example.org";
const SITE = "http://localhost/api/vhr/request";
const AOI = {
  type: "Polygon",
  coordinates: [
    [
      [73.0, 25.0],
      [75.0, 25.0],
      [75.0, 27.0],
      [73.0, 27.0],
      [73.0, 25.0],
    ],
  ],
};

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "10000";
  process.env.EMAIL_PROVIDER = "console";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.org";
  process.env.EMAIL_FIXED_RECIPIENT = FIXED_RECIPIENT;
  process.env.ACCESS_REQUEST_DAILY_CAP = "10";
  process.env.ACCESS_REQUEST_PER_IP_PER_DAY = "3";
  useReadyAuthGate();

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();
  resetAccessRequestState();

  globalThis.fetch = (async () => {
    throw new Error("network disabled in tests");
  }) as typeof fetch;
}

beforeEach(resetState);
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

async function call(
  payload: unknown,
  options: { cookie?: string; origin?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> | null; headers: Headers }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.origin !== undefined) headers.origin = options.origin;
  const response = await requestPost(
    new Request(SITE, { method: "POST", headers, body: JSON.stringify(payload) }),
  );
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

function validPayload(areaName = "Jaipur district") {
  return { aoi: AOI, areaName, startDate: "2026-01-01", endDate: "2026-03-31" };
}

/** Newest loose AOI attachment written by the console provider, if any. */
async function latestAoiAttachment(): Promise<{ name: string; content: string } | null> {
  const dir = path.join(process.cwd(), PREVIEW_DIR_NAME);
  const entries = (await readdir(dir).catch(() => []) as string[])
    .filter((name) => name.endsWith("-0-aoi.geojson"))
    .sort();
  const name = entries.at(-1);
  if (!name) return null;
  return { name, content: await readFile(path.join(dir, name), "utf8") };
}

test("request: cross-origin posts are rejected", async () => {
  const result = await call(validPayload(), {
    cookie: await ssoCookie(),
    origin: "https://evil.example",
  });
  assert.equal(result.status, 403);
  assert.equal(result.body?.code, "CROSS_ORIGIN");
});

test("request: 401 without a session", async () => {
  const result = await call(validPayload());
  assert.equal(result.status, 401);
  assert.equal(result.body?.code, "UNAUTHENTICATED");
});

test("request: guests are allowed (it is how they ask for imagery)", async () => {
  const result = await call(validPayload("Guest area"), { cookie: await guestCookie() });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body?.ok, true);
});

test("request: structurally invalid AOI is 400 INVALID_AOI", async () => {
  const cookie = await ssoCookie();

  const point = await call({ ...validPayload(), aoi: { type: "Point", coordinates: [73, 25] } }, { cookie });
  assert.equal(point.status, 400);
  assert.equal(point.body?.code, "INVALID_AOI");

  const unclosed = await call(
    {
      ...validPayload(),
      aoi: { type: "Polygon", coordinates: [[[73, 25], [75, 25], [75, 27], [73, 26]]] },
    },
    { cookie },
  );
  assert.equal(unclosed.status, 400);
  assert.equal(unclosed.body?.code, "INVALID_AOI");

  const nanRing = await call(
    {
      ...validPayload(),
      aoi: { type: "Polygon", coordinates: [[[73, 25], [75, "x"], [75, 27], [73, 25]]] },
    },
    { cookie },
  );
  assert.equal(nanRing.status, 400);
  assert.equal(nanRing.body?.code, "INVALID_AOI");
});

test("request: inverted dates are 400 INVALID_DATES", async () => {
  const result = await call(
    { ...validPayload(), startDate: "2026-03-31", endDate: "2026-01-01" },
    { cookie: await ssoCookie() },
  );
  assert.equal(result.status, 400);
  assert.equal(result.body?.code, "INVALID_DATES");
});

test("request: honeypot gets a fake 202 without spending quota or dedupe", async () => {
  const payload = { ...validPayload("Honeypot area"), website: "https://spam.example" };
  const result = await call(payload, { cookie: await ssoCookie() });
  assert.equal(result.status, 202);
  assert.equal(result.body?.ok, true);

  // The real send still works afterwards with the same content.
  const real = await call(validPayload("Honeypot area"), { cookie: await ssoCookie() });
  assert.equal(real.status, 202, JSON.stringify(real.body));
  assert.equal(real.body?.duplicate, undefined, "honeypot must not mark the content as sent");
});

test("request: 503 VHR_UNAVAILABLE without a fixed recipient", async () => {
  delete process.env.EMAIL_FIXED_RECIPIENT;
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;

  const result = await call(validPayload(), { cookie: await ssoCookie() });
  assert.equal(result.status, 503);
  assert.equal(result.body?.code, "VHR_UNAVAILABLE");
});

test("request: happy path sends the console email with the AOI attachment", async () => {
  const result = await call(validPayload("Udaipur tehsil"), { cookie: await ssoCookie() });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body?.ok, true);

  const attachment = await latestAoiAttachment();
  assert.ok(attachment, "console provider must write aoi.geojson");
  const feature = JSON.parse(attachment.content) as {
    type: string;
    properties: Record<string, unknown>;
    geometry: { type: string };
  };
  assert.equal(feature.type, "Feature");
  assert.equal(feature.geometry.type, "Polygon");
  assert.equal(feature.properties.areaName, "Udaipur tehsil");
  assert.equal(feature.properties.startDate, "2026-01-01");
  assert.equal(feature.properties.endDate, "2026-03-31");
  assert.match(String(feature.properties.requestId), /^VR-\d{8}-[0-9a-f]{6}$/);
});

test("request: identical content within 10 minutes is a duplicate 202", async () => {
  const first = await call(validPayload("Duplicate area"), { cookie: await ssoCookie() });
  assert.equal(first.status, 202);
  assert.equal(first.body?.duplicate, undefined);

  const second = await call(validPayload("Duplicate area"), { cookie: await ssoCookie() });
  assert.equal(second.status, 202);
  assert.equal(second.body?.duplicate, true);
});

test("request: shared daily quota answers 429 VHR_RATE_LIMITED with Retry-After", async () => {
  process.env.ACCESS_REQUEST_PER_IP_PER_DAY = "1";
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  resetAccessRequestState();

  const cookie = await ssoCookie();
  const first = await call(validPayload("Area one"), { cookie });
  assert.equal(first.status, 202, JSON.stringify(first.body));

  // Different content → passes dedupe → hits the per-IP daily guard.
  const second = await call(validPayload("Area two"), { cookie });
  assert.equal(second.status, 429, JSON.stringify(second.body));
  assert.equal(second.body?.code, "VHR_RATE_LIMITED");
  const retryAfter = Number(second.headers.get("Retry-After"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, `Retry-After=${retryAfter}`);
});
