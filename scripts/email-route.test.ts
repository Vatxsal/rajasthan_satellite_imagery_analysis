import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { GET as getConfig } from "../app/api/compare/email/config/route";
import { POST } from "../app/api/compare/email/route";
import { emailHash } from "../lib/email";
import { emailMarkSent, emailSendKey } from "../lib/email/dedupe";

/** Route-level guard flow for POST /api/compare/email and the public
 *  capability endpoint. Every test stops before real analysis: the mock
 *  data-source guard (400 CDSE_CONFIG) is the "all guards passed" sentinel,
 *  Turnstile is exercised against a mocked siteverify endpoint, and quota
 *  state lives on globalThis so it can be reset between tests. */

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const EMAIL_URL = "http://localhost/api/compare/email";

/** next's types mark NODE_ENV readonly; tests need to flip it temporarily. */
function setNodeEnv(value: string | undefined): void {
  const env = process.env as unknown as { NODE_ENV?: string };
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

const validParams = {
  areaId: "d-jaisalmer",
  level: "district",
  dateA: "2026-10-10",
  dateB: "2026-10-25",
};

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.emailDaily"?: Map<string, unknown>;
  "rse.emailSentLog"?: Map<string, number>;
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "1000";
  process.env.COMPARE_RATE_LIMIT_PER_MIN = "1000";
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.org";
  process.env.EMAIL_PROVIDER = "console";
  delete process.env.EMAIL_FROM;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.RESEND_API_KEY;
  delete process.env.TURNSTILE_SITE_KEY;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.EMAIL_DAILY_CAP;
  delete process.env.EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY;
  delete process.env.EMAIL_RATE_LIMIT_PER_IP_PER_DAY;
  delete process.env.EMAIL_FIXED_RECIPIENT;
  delete process.env.EMAIL_ALLOW_ANY_RECIPIENT;
  setNodeEnv(ORIGINAL_NODE_ENV);

  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
  holder["rse.emailDaily"]?.clear();
  holder["rse.emailSentLog"]?.clear();
  const buckets = holder["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();
}

beforeEach(resetState);

function sendEmail(
  payload: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const request = new Request(EMAIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return POST(request).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    headers: response.headers,
  }));
}

function defaultPayload(): Record<string, unknown> {
  return { email: "citizen@example.org", params: { ...validParams } };
}

function dailyState(): Map<string, unknown> | undefined {
  return (globalThis as unknown as EnvHolder)["rse.emailDaily"];
}

/** Mocks the Cloudflare siteverify endpoint; restore with the returned fn. */
function mockSiteverify(result: { success: boolean; "error-codes"?: string[] }): {
  calls: string[];
  restore: () => void;
} {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

test("cross-origin POSTs are rejected before any other work", async () => {
  const { status, body } = await sendEmail(defaultPayload(), {
    origin: "https://evil.example",
  });
  assert.equal(status, 403);
  assert.equal(body.code, "CROSS_ORIGIN");
});

test("same-origin POSTs pass the origin guard", async () => {
  const { status, body } = await sendEmail(defaultPayload(), {
    origin: "http://localhost",
  });
  // Reaches the mock-source guard — proves Origin matching lets traffic through.
  assert.equal(status, 400);
  assert.equal(body.code, "CDSE_CONFIG");
});

test("malformed JSON is rejected with INVALID_JSON", async () => {
  const request = new Request(EMAIL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not-json{{",
  });
  const response = await POST(request);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { code?: string };
  assert.equal(body.code, "INVALID_JSON");
});

test("identical dates are rejected by the schema refine", async () => {
  const { status, body } = await sendEmail({
    email: "citizen@example.org",
    params: { ...validParams, dateB: validParams.dateA },
  });
  assert.equal(status, 400);
  assert.equal(body.code, "INVALID_REQUEST");
  assert.match(String(body.message), /Pick two different dates/);
});

test("honeypot replies with a fake 202 and consumes no quota", async () => {
  const { status, body } = await sendEmail({
    ...defaultPayload(),
    website: "http://spam.example",
  });
  assert.equal(status, 202);
  assert.equal(body.ok, true);
  assert.equal(dailyState()?.size ?? 0, 0);
});

test("an invalid recipient fails with EMAIL_INVALID before quota", async () => {
  const { status, body } = await sendEmail({
    ...defaultPayload(),
    email: "not-an-email",
  });
  assert.equal(status, 400);
  assert.equal(body.code, "EMAIL_INVALID");
  assert.equal(dailyState()?.size ?? 0, 0);
});

test("an oversized payload is rejected with PAYLOAD_TOO_LARGE", async () => {
  const { status, body } = await sendEmail({
    ...defaultPayload(),
    padding: "x".repeat(8_100),
  });
  assert.equal(status, 413);
  assert.equal(body.code, "PAYLOAD_TOO_LARGE");
});

test("Turnstile enabled without a token fails closed", async () => {
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  const { status, body } = await sendEmail(defaultPayload());
  assert.equal(status, 403);
  assert.equal(body.code, "EMAIL_CAPTCHA_FAILED");
});

test("Turnstile rejects a token the siteverify endpoint refuses", async () => {
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  const mock = mockSiteverify({ success: false, "error-codes": ["invalid-input"] });
  try {
    const { status, body } = await sendEmail({
      ...defaultPayload(),
      turnstileToken: "bad-token",
    });
    assert.equal(status, 403);
    assert.equal(body.code, "EMAIL_CAPTCHA_FAILED");
    assert.equal(mock.calls.length, 1);
    assert.match(
      mock.calls[0]!,
      /^https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/,
    );
  } finally {
    mock.restore();
  }
});

test("a valid Turnstile token passes through to the analysis stage", async () => {
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  const mock = mockSiteverify({ success: true });
  try {
    const { status, body } = await sendEmail({
      ...defaultPayload(),
      turnstileToken: "good-token",
    });
    assert.equal(status, 400);
    assert.equal(body.code, "CDSE_CONFIG");
    assert.equal(mock.calls.length, 1);
  } finally {
    mock.restore();
  }
});

test("a fully valid request reaches the analysis stage (mock-source guard)", async () => {
  const { status, body } = await sendEmail(defaultPayload());
  assert.equal(status, 400);
  assert.equal(body.code, "CDSE_CONFIG");
  assert.match(String(body.message), /NEXT_PUBLIC_DATA_SOURCE/);
  // Quota was consumed before the analysis guard — mirrors production order.
  assert.equal(dailyState()?.size ?? 0, 3); // global + ip + addr keys
});

test("the daily quota blocks the second send with Retry-After", async () => {
  process.env.EMAIL_DAILY_CAP = "1";
  const first = await sendEmail(defaultPayload());
  assert.equal(first.status, 400); // consumed quota, then stopped at mock source

  const second = await sendEmail({
    ...defaultPayload(),
    email: "another@example.org",
  });
  assert.equal(second.status, 429);
  assert.equal(second.body.code, "EMAIL_RATE_LIMITED");
  const retryAfter = Number(second.headers.get("retry-after"));
  assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1, "Retry-After header");
  // UTC midnight is 05:30 IST — the message states the local reset time.
  assert.equal(second.body.message, "Daily limit reached; try again after 05:30 IST.");
});

test("the console provider refuses to send in a production build", async () => {
  setNodeEnv("production");
  const { status, body } = await sendEmail(defaultPayload());
  assert.equal(status, 503);
  assert.equal(body.code, "EMAIL_DISABLED");
});

test("config endpoint reports capabilities without leaking secrets", async () => {
  const response = getConfig();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=300");
  const body = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "captchaRequired",
    "dailyCapReached",
    "enabled",
    "mode",
    "provider",
    "reason",
    "recipientHint",
    "summaryAvailable",
    "turnstileSiteKey",
  ]);
  assert.equal(body.enabled, true);
  assert.equal(body.provider, "console");
  assert.equal(body.mode, "open");
  assert.equal(body.recipientHint, null);
  assert.equal(body.captchaRequired, false);
  assert.equal(body.dailyCapReached, false);
  assert.equal(body.summaryAvailable, false);
  assert.equal(body.turnstileSiteKey, null);
  assert.equal(body.reason, null);
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("SECRET"), "no secrets in the capability payload");
  assert.ok(!raw.includes("PASS"), "no secrets in the capability payload");
});

test("config endpoint hides the button when Turnstile is half-configured", async () => {
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  const body = (await getConfig().json()) as Record<string, unknown>;
  assert.equal(body.enabled, false);
  assert.match(String(body.reason), /TURNSTILE_SITE_KEY/);
  assert.equal(body.turnstileSiteKey, null);
});

test("config endpoint exposes the site key only when both are set", async () => {
  process.env.TURNSTILE_SECRET_KEY = "test-secret";
  process.env.TURNSTILE_SITE_KEY = "site-key-public";
  const body = (await getConfig().json()) as Record<string, unknown>;
  assert.equal(body.enabled, true);
  assert.equal(body.turnstileSiteKey, "site-key-public");
});

test("config endpoint hides the button when email is disabled in production", async () => {
  setNodeEnv("production");
  const body = (await getConfig().json()) as Record<string, unknown>;
  assert.equal(body.enabled, false);
  assert.match(String(body.reason), /EMAIL_PROVIDER=console/);
});

// ── Fixed-recipient mode (EMAIL_FIXED_RECIPIENT) ────────────────────────────

test("fixed mode rejects a client-supplied email field before any work", async () => {
  process.env.EMAIL_FIXED_RECIPIENT = "chief@example.org";
  const { status, body } = await sendEmail(defaultPayload()); // carries `email`
  assert.equal(status, 400);
  assert.equal(body.code, "EMAIL_INVALID");
  assert.match(String(body.message), /configured address/);
  assert.equal(dailyState()?.size ?? 0, 0, "rejected before quota");
});

test("fixed mode without an email field reaches the analysis stage", async () => {
  process.env.EMAIL_FIXED_RECIPIENT = "chief@example.org";
  const { status, body } = await sendEmail({ params: { ...validParams } });
  assert.equal(status, 400);
  assert.equal(body.code, "CDSE_CONFIG"); // all guards passed; recipient came from env
  assert.equal(dailyState()?.size ?? 0, 3); // global + ip + addr, as in open mode
});

test("config endpoint masks the fixed recipient and never leaks the address", async () => {
  process.env.EMAIL_FIXED_RECIPIENT = "Chief@Example.org";
  const response = getConfig();
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.mode, "fixed");
  assert.equal(body.recipientHint, "c***@example.org");
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("Chief@Example.org"), "full address absent from payload");
  assert.ok(!raw.includes("chief@example.org"), "normalised address absent from payload");
});

test("an identical recent send answers alreadySent and consumes no quota", async () => {
  process.env.EMAIL_FIXED_RECIPIENT = "chief@example.org";
  // Seed exactly the key the route computes for this request (defaults:
  // language=en, includeSummary/includeImage=true, engine v1 → single-date).
  // Matching proves the route resolved the recipient from the env var.
  const seedKey = emailSendKey({
    params: {
      ...validParams,
      sensitivity: "medium",
      minPatchHa: 0.2,
      inputMode: "composite",
      compositeWindowDays: 0,
    },
    language: "en",
    includeSummary: true,
    includeImage: true,
    engine: "v1",
    recipientHash: emailHash("chief@example.org"),
  });
  emailMarkSent(seedKey);

  const { status, body } = await sendEmail({ params: { ...validParams } });
  assert.equal(status, 202);
  assert.equal(body.ok, true);
  assert.equal(body.alreadySent, true);
  assert.equal(dailyState()?.size ?? 0, 0, "duplicate sends consume no quota");
});

// ── Production recipient policy ─────────────────────────────────────────────

test("production refuses typed-address sending unless explicitly allowed", async () => {
  setNodeEnv("production");
  const { status, body } = await sendEmail(defaultPayload());
  assert.equal(status, 503);
  assert.equal(body.code, "EMAIL_DISABLED");
  assert.match(String(body.message), /EMAIL_ALLOW_ANY_RECIPIENT/);
});

test("production passes typed addresses through when EMAIL_ALLOW_ANY_RECIPIENT=true", async () => {
  setNodeEnv("production");
  process.env.EMAIL_ALLOW_ANY_RECIPIENT = "true";
  process.env.EMAIL_PROVIDER = "smtp";
  process.env.SMTP_HOST = "smtp.example.org";
  process.env.EMAIL_FROM = "Rajasthan Imagery Explorer <reports@example.org>";
  const { status, body } = await sendEmail(defaultPayload());
  assert.equal(status, 400);
  assert.equal(body.code, "CDSE_CONFIG"); // refused nowhere → reached analysis
});

test("production fixed mode works without EMAIL_ALLOW_ANY_RECIPIENT", async () => {
  setNodeEnv("production");
  process.env.EMAIL_FIXED_RECIPIENT = "chief@example.org";
  process.env.EMAIL_PROVIDER = "smtp";
  process.env.SMTP_HOST = "smtp.example.org";
  process.env.EMAIL_FROM = "Rajasthan Imagery Explorer <reports@example.org>";
  const { status, body } = await sendEmail({ params: { ...validParams } });
  assert.equal(status, 400);
  assert.equal(body.code, "CDSE_CONFIG");
});
