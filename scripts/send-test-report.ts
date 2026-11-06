/**
 * Sends ONE real report email through the configured provider to
 * EMAIL_TEST_RECIPIENT — the end-to-end provider check (SMTP auth, Resend
 * domain, attachment/CID handling). With EMAIL_PROVIDER=console (default)
 * it writes a preview instead, exactly like the route does in dev.
 *
 * Usage: npm run email:test [-- --fixture=hindi]
 * Env:   EMAIL_TEST_RECIPIENT (required), plus the EMAIL_, SMTP_ and
 *        RESEND_ settings the provider needs.
 */
import {
  assertEmailReady,
  getEmailProvider,
  maskEmail,
} from "../lib/email/index";
import { getServerEnv } from "../lib/env";
import {
  buildReportEmailData,
  renderReportEmail,
} from "../lib/email/template";
import { buildFixtures, solidJpegBuffer } from "../lib/email/template/fixtures";
import fs from "node:fs";
import path from "node:path";

/**
 * Plain `node` does not load .env files (only next dev/build does), so
 * mirror the KEY=VALUE lines from .env and .env.local into process.env.
 * Real environment variables always win.
 */
function loadLocalEnv(): void {
  for (const file of [".env", ".env.local"]) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

async function main(): Promise<void> {
  loadLocalEnv();
  const env = getServerEnv();
  const recipient = env.EMAIL_TEST_RECIPIENT?.trim();
  if (!recipient) {
    console.error(
      "EMAIL_TEST_RECIPIENT is not set — add it to .env.local to send a test report.",
    );
    process.exit(1);
  }
  assertEmailReady(env);

  const fixtureArg = process.argv.find((arg) => arg.startsWith("--fixture="));
  const fixtureName = fixtureArg ? fixtureArg.slice("--fixture=".length) : "all-events";
  const fixture = buildFixtures().find((entry) => entry.name === fixtureName);
  if (!fixture) {
    console.error(
      `Unknown fixture "${fixtureName}". Available: ${buildFixtures()
        .map((entry) => entry.name)
        .join(", ")}`,
    );
    process.exit(1);
  }

  // Swap the preview's data-URI image for a CID attachment — real clients
  // (Gmail especially) strip data: URIs from email HTML.
  const jpeg = solidJpegBuffer(700, 500, [122, 130, 140]);
  const data = buildReportEmailData({
    ...fixture.input,
    image: {
      src: "cid:changemap-test",
      width: 700,
      height: 500,
      alt: fixture.input.language === "hi" ? "परिवर्तन मानचित्र" : "Change map",
    },
  });
  const rendered = await renderReportEmail(data);

  const provider = getEmailProvider(env);
  const started = Date.now();
  const result = await provider.send({
    to: recipient,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    inlineImages: [
      {
        cid: "changemap-test",
        filename: "change-map.jpg",
        content: jpeg,
        contentType: "image/jpeg",
      },
    ],
  });
  console.log(
    `test report ${result.provider} → ${maskEmail(recipient)} ` +
      `fixture=${fixture.name} htmlBytes=${Buffer.byteLength(rendered.html, "utf8")} ` +
      `messageId=${result.messageId} durationMs=${Date.now() - started}`,
  );
}

main().catch((error: unknown) => {
  console.error("EMAIL TEST FAILED:", error);
  process.exit(1);
});
