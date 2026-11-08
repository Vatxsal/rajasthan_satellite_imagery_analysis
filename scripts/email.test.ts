import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  emailAddressOf,
  emailHash,
  isValidEmail,
  isValidFromField,
  maskEmail,
  normalizeEmail,
} from "../lib/email/address";
import { buildEml } from "../lib/email/eml";
import { PREVIEW_DIR_NAME, createConsoleProvider } from "../lib/email/providers/console";
import {
  EmailSendError,
  assertEmailReady,
  emailDeliveryEnabled,
  getEmailProvider,
  siteUrl,
} from "../lib/email/index";
import { getServerEnv, type ServerEnv } from "../lib/env";

/** Email-report provider layer: address handling, .eml writer, console
 *  previews, and the provider factory (smtp/resend adapters are mocked in
 *  the Phase 6 route tests). */

function envFixture(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    CDSE_CLIENT_ID: undefined,
    CDSE_CLIENT_SECRET: undefined,
    CDSE_TOKEN_URL: "https://identity.example/token",
    CDSE_SH_BASE_URL: "https://sh.example",
    CDSE_WMTS_INSTANCE_ID: undefined,
    MAX_AOI_KM2: 70_000,
    IMAGERY_CACHE_TTL_SECONDS: 86_400,
    RATE_LIMIT_PER_MIN: 30,
    RATE_LIMIT_TILES_PER_MIN: 240,
    TILE_CACHE_DIR: undefined,
    DAILY_RENDER_BUDGET: 3000,
    COMPARE_MAX_PX: 1500,
    PER_ANALYSIS_PU_LIMIT: 700,
    CHANGE_ENGINE: "v1",
    S1_ENABLED: true,
    S1_WINDOW_DAYS: 6,
    COMPARE_RATE_LIMIT_PER_MIN: 6,
    AI_SUMMARY_RATE_LIMIT_PER_MIN: 5,
    GEMINI_API_KEY: undefined,
    GEMINI_MODEL: "gemini-2.5-flash",
    EMAIL_PROVIDER: "console",
    EMAIL_FROM: "Rajasthan Imagery Explorer <reports@example.org>",
    SMTP_HOST: undefined,
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    RESEND_API_KEY: undefined,
    EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY: 3,
    EMAIL_RATE_LIMIT_PER_IP_PER_DAY: 10,
    EMAIL_DAILY_CAP: 80,
    EMAIL_ATTACH_CSV: true,
    EMAIL_FIXED_RECIPIENT: undefined,
    EMAIL_ALLOW_ANY_RECIPIENT: false,
    EMAIL_TEST_RECIPIENT: undefined,
    TURNSTILE_SITE_KEY: undefined,
    TURNSTILE_SECRET_KEY: undefined,
    NEXT_PUBLIC_SITE_URL: "https://example.org",
    ...overrides,
  };
}

const reportMessage = {
  to: "citizen@example.com",
  subject: "Change report · Jaisalmer · 2026-01-01 to 2026-02-01 (auto-generated)",
  html: '<html><body><h1>Report</h1><img src="cid:changemap" alt="change map" /></body></html>',
  text: "Report\nOpen the change map in the app.",
  inlineImages: [
    {
      cid: "changemap",
      filename: "changemap.jpg",
      content: Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x42]),
      contentType: "image/jpeg",
    },
  ],
  attachments: [
    {
      filename: "events.csv",
      content: Buffer.from("id,class,area_ha\nev_aaaaaaaa,Vegetation loss,36.1\n", "utf8"),
      contentType: "text/csv",
    },
  ],
};

test("isValidEmail accepts plain mailboxes and rejects header-injection attempts", () => {
  assert.equal(isValidEmail("Citizen@Example.COM "), true);
  assert.equal(isValidEmail("user+tag@domain.in"), true);
  assert.equal(isValidEmail("नागरिक@example.org"), true);
  assert.equal(isValidEmail("plain address"), false);
  assert.equal(isValidEmail("no-tld@example"), false);
  assert.equal(isValidEmail("two@@ats.example.org"), false);
  assert.equal(isValidEmail("a@b.in\r\nBcc: victim@example.org"), false);
  assert.equal(isValidEmail("spaces in@local.example"), false);
  assert.equal(isValidEmail(`${"x".repeat(250)}@example.org`), false);
  assert.equal(isValidEmail(""), false);
});

test("normalizeEmail trims and lowercases", () => {
  assert.equal(normalizeEmail("  Citizen@Example.COM "), "citizen@example.com");
});

test("emailHash is stable, hex, and never contains the address", () => {
  const hash = emailHash("Citizen@Example.COM");
  assert.equal(hash, emailHash(" citizen@example.com "));
  assert.match(hash, /^[0-9a-f]{32}$/);
  assert.ok(!hash.toLowerCase().includes("citizen"));
});

test("maskEmail shows only the first local character", () => {
  assert.equal(maskEmail("citizen@gmail.com"), "c***@gmail.com");
  assert.equal(maskEmail("a@b.in"), "a***@b.in");
  assert.equal(maskEmail("not-an-address"), "***");
});

test("emailAddressOf extracts the mailbox from a display-name field", () => {
  assert.equal(emailAddressOf("Rajasthan Imagery Explorer <reports@example.org>"), "reports@example.org");
  assert.equal(emailAddressOf("reports@example.org"), "reports@example.org");
  assert.equal(isValidFromField("Rajasthan Imagery Explorer <reports@example.org>"), true);
  assert.equal(isValidFromField("broken <no-at>"), false);
});

test("buildEml produces a plain multipart/alternative document", () => {
  const eml = buildEml({
    from: "Rajasthan Imagery Explorer <reports@example.org>",
    to: "citizen@example.com",
    subject: "Plain report",
    html: "<p>Hello</p>",
    text: "Hello",
  });
  assert.match(eml, /Content-Type: multipart\/alternative; boundary="rse-[0-9a-f]{24}"/);
  assert.match(eml, /Content-Type: text\/html; charset=utf-8/);
  assert.match(eml, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(eml, /From: Rajasthan Imagery Explorer <reports@example\.org>/);
  assert.match(eml, /Subject: Plain report/);
  assert.ok(!eml.includes("multipart/related"));
  // Every line ends with CRLF (no bare LF anywhere).
  assert.equal(/(?<!\r)\n/.test(eml), false);
});

test("buildEml wraps inline images in multipart/related with Content-ID", () => {
  const eml = buildEml({
    from: "Rajasthan Imagery Explorer <reports@example.org>",
    to: "citizen@example.com",
    subject: "Image report",
    html: '<img src="cid:changemap" />',
    text: "See the change map.",
    attachments: [
      {
        filename: "changemap.jpg",
        content: reportMessage.inlineImages[0]!.content,
        contentType: "image/jpeg",
        cid: "changemap",
      },
      {
        filename: "events.csv",
        content: reportMessage.attachments[0]!.content,
        contentType: "text/csv",
      },
    ],
  });
  assert.match(eml, /Content-Type: multipart\/related; boundary="rse-/);
  assert.match(eml, /Content-ID: <changemap>/);
  assert.match(eml, /Content-Disposition: inline; filename="changemap\.jpg"/);
  assert.match(eml, /Content-Disposition: attachment; filename="events\.csv"/);
  assert.match(eml, /Content-Type: text\/csv; name="events\.csv"/);
});

test("buildEml encodes non-ASCII subjects as RFC 2047 words", () => {
  const eml = buildEml({
    from: "reports@example.org",
    to: "citizen@example.com",
    subject: "बदलाव रिपोर्ट · जैसलमेर",
    html: "<p>नमस्ते</p>",
    text: "नमस्ते",
  });
  assert.match(eml, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
  // Non-ASCII bodies travel base64-encoded.
  assert.match(eml, /Content-Transfer-Encoding: base64/);
});

test("console provider writes html/txt/eml previews plus loose binary parts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "rse-email-"));
  try {
    const provider = createConsoleProvider({
      dir,
      from: "Rajasthan Imagery Explorer <reports@example.org>",
    });
    const result = await provider.send(reportMessage);
    assert.equal(result.provider, "console");
    assert.ok(result.messageId.includes(PREVIEW_DIR_NAME));

    const files = await (await import("node:fs/promises")).readdir(dir);
    const html = files.filter((name) => name.endsWith(".html"));
    const txt = files.filter((name) => name.endsWith(".txt"));
    const eml = files.filter((name) => name.endsWith(".eml"));
    assert.equal(html.length, 1);
    assert.equal(txt.length, 1);
    assert.equal(eml.length, 1);
    // Inline image + CSV are written as loose files for size checks.
    assert.ok(files.some((name) => name.endsWith("-0-changemap.jpg")));
    assert.ok(files.some((name) => name.endsWith("-1-events.csv")));

    const htmlBody = await readFile(path.join(dir, html[0]!), "utf8");
    assert.equal(htmlBody, reportMessage.html);
    const txtBody = await readFile(path.join(dir, txt[0]!), "utf8");
    assert.equal(txtBody, reportMessage.text);
    const emlBody = await readFile(path.join(dir, eml[0]!), "utf8");
    assert.match(emlBody, /Content-ID: <changemap>/);
    assert.match(emlBody, /filename="events\.csv"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("factory selects the provider from EMAIL_PROVIDER", async () => {
  const consoleProvider = getEmailProvider(envFixture());
  assert.equal(consoleProvider.id, "console");
  assert.equal(emailDeliveryEnabled(envFixture()), false);

  const smtpProvider = getEmailProvider(
    envFixture({ EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.org" }),
  );
  assert.equal(smtpProvider.id, "smtp");
  assert.equal(emailDeliveryEnabled(envFixture({ EMAIL_PROVIDER: "smtp" })), true);

  const resendProvider = getEmailProvider(
    envFixture({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" }),
  );
  assert.equal(resendProvider.id, "resend");
});

test("assertEmailReady fails closed with EMAIL_DISABLED", () => {
  // Console previews are the dev workflow; production builds must refuse.
  const mutableEnv = process.env as unknown as { NODE_ENV?: string };
  const previousNodeEnv = mutableEnv.NODE_ENV;
  try {
    mutableEnv.NODE_ENV = "production";
    assert.throws(
      () => assertEmailReady(envFixture()),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_DISABLED");
        return true;
      },
      "console provider in production",
    );
  } finally {
    mutableEnv.NODE_ENV = previousNodeEnv;
  }
  // Dev: console + siteUrl is ready (writes previews, never sends).
  assert.doesNotThrow(() => assertEmailReady(envFixture()));

  for (const env of [
    envFixture({ EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.org", NEXT_PUBLIC_SITE_URL: undefined }),
    envFixture({ EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.org", EMAIL_FROM: undefined }),
    envFixture({ EMAIL_PROVIDER: "smtp", EMAIL_FROM: undefined, SMTP_HOST: undefined }),
    envFixture({ EMAIL_PROVIDER: "resend", EMAIL_FROM: undefined }),
    envFixture({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: undefined }),
  ]) {
    assert.throws(
      () => assertEmailReady(env),
      (error: unknown) => {
        assert.ok(error instanceof EmailSendError);
        assert.equal(error.code, "EMAIL_DISABLED");
        assert.equal(error.status, 503);
        return true;
      },
      JSON.stringify({ provider: env.EMAIL_PROVIDER, from: env.EMAIL_FROM, site: env.NEXT_PUBLIC_SITE_URL }),
    );
  }
  // Complete configs pass silently.
  assert.doesNotThrow(() => assertEmailReady(envFixture({ EMAIL_PROVIDER: "smtp", SMTP_HOST: "smtp.example.org" })));
  assert.doesNotThrow(() => assertEmailReady(envFixture({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_test" })));
});

test("siteUrl normalises to an origin and rejects garbage", () => {
  assert.equal(siteUrl(envFixture()), "https://example.org");
  assert.equal(siteUrl(envFixture({ NEXT_PUBLIC_SITE_URL: "https://example.org/app/" })), "https://example.org");
  assert.equal(siteUrl(envFixture({ NEXT_PUBLIC_SITE_URL: "not a url" })), null);
  assert.equal(siteUrl(envFixture({ NEXT_PUBLIC_SITE_URL: undefined })), null);
});

test("getServerEnv enforces provider-specific email settings", () => {
  // Isolate: this test mutates process.env. node --test runs this file in
  // its own process; the env holder is reset between runs via globalThis.
  const previous = { ...process.env };
  const resetEnvCache = () => {
    const holder = (globalThis as { [key: string]: unknown })["rse.serverEnv"] as
      | { cached: unknown }
      | undefined;
    if (holder) holder.cached = null;
  };
  try {
    delete process.env.NEXT_PUBLIC_DATA_SOURCE;
    delete process.env.CDSE_CLIENT_ID;
    delete process.env.CDSE_CLIENT_SECRET;
    delete process.env.SMTP_HOST;
    delete process.env.EMAIL_FROM;
    delete process.env.RESEND_API_KEY;
    process.env.EMAIL_PROVIDER = "smtp"; // missing SMTP_HOST + EMAIL_FROM
    resetEnvCache();

    assert.throws(
      () => getServerEnv(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid environment configuration/);
        assert.match(error.message, /SMTP_HOST is required/);
        assert.match(error.message, /EMAIL_FROM is required/);
        return true;
      },
      "incomplete smtp config must fail closed",
    );

    // Fix the config → parses cleanly. "false" token must read as boolean false.
    process.env.SMTP_HOST = "smtp.example.org";
    process.env.EMAIL_FROM = "Rajasthan Imagery Explorer <reports@example.org>";
    process.env.SMTP_SECURE = "false";
    const env = getServerEnv();
    assert.equal(env.EMAIL_PROVIDER, "smtp");
    assert.equal(env.SMTP_HOST, "smtp.example.org");
    assert.equal(env.SMTP_SECURE, false);

    // Later mutations are ignored — the holder caches the first success.
    process.env.SMTP_SECURE = "true";
    assert.equal(getServerEnv().SMTP_SECURE, false);

    // Fresh cache picks up the "true" token as boolean true.
    resetEnvCache();
    assert.equal(getServerEnv().SMTP_SECURE, true);

    // A bad EMAIL_FROM shape fails the same contract check.
    resetEnvCache();
    process.env.EMAIL_FROM = "broken <no-at-sign>";
    assert.throws(
      () => getServerEnv(),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Invalid environment configuration/);
        assert.match(error.message, /EMAIL_FROM/);
        return true;
      },
    );
  } finally {
    process.env = previous;
    resetEnvCache();
  }
});

test("getServerEnv validates EMAIL_FIXED_RECIPIENT as a single mailbox", () => {
  const previous = { ...process.env };
  const resetEnvCache = () => {
    const holder = (globalThis as { [key: string]: unknown })["rse.serverEnv"] as
      | { cached: unknown }
      | undefined;
    if (holder) holder.cached = null;
  };
  try {
    // Unset or blank → typed-address (open) mode.
    delete process.env.EMAIL_FIXED_RECIPIENT;
    resetEnvCache();
    assert.equal(getServerEnv().EMAIL_FIXED_RECIPIENT, undefined);

    process.env.EMAIL_FIXED_RECIPIENT = "   ";
    resetEnvCache();
    assert.equal(getServerEnv().EMAIL_FIXED_RECIPIENT, undefined);

    // A valid address is trimmed and kept as-is (masking happens at read).
    process.env.EMAIL_FIXED_RECIPIENT = " Chief@Example.org ";
    resetEnvCache();
    assert.equal(getServerEnv().EMAIL_FIXED_RECIPIENT, "Chief@Example.org");

    // Anything that is not exactly one mailbox fails closed.
    for (const bad of ["not-an-email", "a@b.c, d@e.f", "two@@ats.example.org"]) {
      process.env.EMAIL_FIXED_RECIPIENT = bad;
      resetEnvCache();
      assert.throws(
        () => getServerEnv(),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /EMAIL_FIXED_RECIPIENT/);
          assert.match(error.message, /must be a single valid email address/);
          return true;
        },
        bad,
      );
    }
  } finally {
    process.env = previous;
    resetEnvCache();
  }
});
