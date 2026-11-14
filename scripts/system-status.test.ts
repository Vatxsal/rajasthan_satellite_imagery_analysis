import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { GET as sessionGet } from "../app/api/auth/session/route";
import { GET as systemStatusGet } from "../app/api/system/status/route";
import {
  PERMISSIONS,
  limitsFor,
  type Capability,
  type QuotaKind,
} from "../lib/auth/permissions";
import {
  bumpGlobalCounter,
  consumeQuota,
  quotaUsage,
  readGlobalCounters,
  resetRoleQuotas,
} from "../lib/auth/quota";
import { guestCookie, ssoCookie, useOpenAuthGate, useReadyAuthGate } from "./test-session";

/** Session payload + SSO-only /api/system/status + global daily counters. */

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
  "rse.globalCounters"?: { counts: Map<string, number> };
}

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "10000";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.org";
  process.env.EMAIL_PROVIDER = "console";
  delete process.env.GEMINI_API_KEY;
  delete process.env.EMAIL_FIXED_RECIPIENT;
  delete process.env.TURNSTILE_SECRET_KEY;
  useReadyAuthGate();

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();
  resetRoleQuotas();
}

beforeEach(resetState);

async function call(
  handler: (request: Request) => Promise<Response>,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> | null; headers: Headers }> {
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
  return { status: response.status, body, headers: response.headers };
}

function get(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

// ---------------------------------------------------------------- session

test("session: 401 when the gate is on and no cookie exists", async () => {
  const result = await call(sessionGet, get("http://localhost/api/auth/session"));
  assert.equal(result.status, 401);
  assert.equal(result.body?.code, "UNAUTHENTICATED");
});

test("session: ambient guest payload when the gate is off", async () => {
  useOpenAuthGate();
  const result = await call(sessionGet, get("http://localhost/api/auth/session"));
  assert.equal(result.status, 200);
  assert.equal(result.body?.role, "guest");
  assert.equal(result.body?.name, "Guest");
  const capabilities = result.body?.capabilities as Record<Capability, boolean>;
  assert.equal(capabilities["scenes.search"], true);
  assert.equal(capabilities["ai.summary"], false);
  assert.equal(capabilities["system.status"], false);
  const usage = result.body?.usageToday as Record<QuotaKind, { used: number; limit: number; remaining: number }>;
  assert.equal(usage.search.limit, 30);
  assert.equal(usage.search.used, 0);
  assert.equal(usage.search.remaining, 30);
  assert.equal(usage.compare.limit, 3);
  assert.equal(usage.aiSummary.limit, 0);
});

test("session: guest cookie returns guest policy + usage", async () => {
  const cookie = await guestCookie("guest:session-test-1");
  // Spend one search for this guest subject so usage shows up.
  consumeQuota("search", { sub: "guest:session-test-1", ip: "local" }, 30);
  const result = await call(sessionGet, get("http://localhost/api/auth/session", cookie));
  assert.equal(result.status, 200);
  assert.equal(result.body?.role, "guest");
  assert.deepEqual(result.body?.limits, limitsFor("guest"));
  const usage = result.body?.usageToday as Record<QuotaKind, { used: number; limit: number }>;
  assert.equal(usage.search.used, 1);
  assert.equal(usage.compare.used, 0);
});

test("session: SSO cookie returns full capabilities", async () => {
  const cookie = await ssoCookie("session-sso");
  const result = await call(sessionGet, get("http://localhost/api/auth/session", cookie));
  assert.equal(result.status, 200);
  assert.equal(result.body?.role, "sso");
  assert.equal(result.body?.name, "Test SSO");
  const capabilities = result.body?.capabilities as Record<Capability, boolean>;
  for (const [capability, expected] of Object.entries(PERMISSIONS.sso.capabilities)) {
    assert.equal(capabilities[capability as Capability], expected, capability);
  }
  const usage = result.body?.usageToday as Record<QuotaKind, { limit: number }>;
  assert.equal(usage.search.limit, 300);
  assert.equal(usage.compare.limit, 50);
  assert.equal(usage.aiSummary.limit, 30);
  // Never leak the subject or token.
  assert.equal(result.body?.sub, undefined);
  assert.equal(result.body?.token, undefined);
});

// ---------------------------------------------------------------- system status

test("system status: 401 without a session", async () => {
  const result = await call(systemStatusGet, get("http://localhost/api/system/status"));
  assert.equal(result.status, 401);
  assert.equal(result.body?.code, "UNAUTHENTICATED");
});

test("system status: guest gets 403 FORBIDDEN_ROLE", async () => {
  const cookie = await guestCookie();
  const result = await call(systemStatusGet, get("http://localhost/api/system/status", cookie));
  assert.equal(result.status, 403);
  assert.equal(result.body?.code, "FORBIDDEN_ROLE");
  assert.equal(result.body?.message, "Sign in with an SSO ID to use this");
  assert.equal(result.body?.required, "sso");
});

test("system status: SSO gets health + counters + no secrets", async () => {
  const cookie = await ssoCookie();
  bumpGlobalCounter("render");
  bumpGlobalCounter("render");
  bumpGlobalCounter("analyze");
  consumeQuota("search", { sub: "test-sso-user", ip: "local" }, 300);

  const result = await call(systemStatusGet, get("http://localhost/api/system/status", cookie));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.headers.get("cache-control"), "no-store");

  assert.equal(result.body?.dataSource, "mock");
  assert.ok(typeof result.body?.buildVersion === "string" && result.body.buildVersion.length > 0);
  assert.ok((result.body?.districts as number) > 0);
  assert.ok((result.body?.tehsils as number) > 0);

  const health = result.body?.health as Record<string, { status: string; message?: string }>;
  assert.equal(health.cdse.status, "mock");
  assert.equal(health.gemini.status, "unconfigured");
  assert.equal(health.email.status, "disabled");

  const today = result.body?.today as Record<string, number>;
  assert.equal(today.render, 2);
  assert.equal(today.analyze, 1);
  assert.equal(today.ai, 0);
  assert.equal(today.email, 0);

  const roleUsage = result.body?.roleUsage as Record<string, { used: number; limit: number }>;
  assert.equal(roleUsage.search.used, 1);
  assert.equal(roleUsage.search.limit, 300);

  const limits = result.body?.limits as { tileZoomMax: number; downloadMaxPx: number };
  assert.equal(limits.tileZoomMax, 14);
  assert.equal(limits.downloadMaxPx, 2500);

  const raw = JSON.stringify(result.body);
  assert.ok(!raw.includes("SESSION_SECRET"), "must not leak SESSION_SECRET");
  assert.ok(!raw.includes("test-session-secret"), "must not leak the session secret");
  // Unconfigured messages may name the env var; never echo a key value.
  const geminiMessage = health.gemini.message ?? "";
  assert.ok(
    !geminiMessage.includes("=") || geminiMessage.includes("not set"),
    "gemini message must not carry a key value",
  );
});

// ---------------------------------------------------------------- global counters

test("global counters: bump/read/reset across UTC days", () => {
  resetRoleQuotas();
  assert.deepEqual(readGlobalCounters(), { render: 0, analyze: 0, ai: 0, email: 0 });

  bumpGlobalCounter("render");
  bumpGlobalCounter("render");
  bumpGlobalCounter("email");
  assert.deepEqual(readGlobalCounters(), { render: 2, analyze: 0, ai: 0, email: 1 });

  // A different UTC day does not mix into today's tally.
  const otherDay = Date.now() + 86_400_000;
  bumpGlobalCounter("analyze", otherDay);
  assert.equal(readGlobalCounters().analyze, 0);
  assert.equal(readGlobalCounters(otherDay).analyze, 1);

  resetRoleQuotas();
  assert.deepEqual(readGlobalCounters(), { render: 0, analyze: 0, ai: 0, email: 0 });
  assert.deepEqual(readGlobalCounters(otherDay), { render: 0, analyze: 0, ai: 0, email: 0 });
});

test("quotaUsage reports binding usage without mutating counters", () => {
  resetRoleQuotas();
  consumeQuota("compare", { sub: "ssoUsage", ip: "local" }, 50);
  const usage = quotaUsage("compare", { sub: "ssoUsage", ip: "local" }, 50);
  assert.equal(usage.used, 1);
  assert.equal(usage.limit, 50);
  assert.equal(usage.remaining, 49);
  // Second read is stable (no side effects).
  assert.equal(quotaUsage("compare", { sub: "ssoUsage", ip: "local" }, 50).used, 1);
});
