import "./alias-hook"; // must be first: installs the "@/…" resolver before the graph loads

import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeCredential } from "../lib/cdse/auth";
import { CdseHttpError, mapCdseStatus } from "../lib/cdse/errors";

test("mapCdseStatus surfaces the Sentinel Hub account detail on 403", () => {
  const err = mapCdseStatus(
    403,
    JSON.stringify({
      error: {
        status: 403,
        reason: "Forbidden",
        message: "Invalid or expired account.",
        code: "COMMON_INSUFFICIENT_PERMISSIONS",
      },
    }),
  );
  assert.ok(err instanceof CdseHttpError);
  assert.equal(err.status, 502);
  assert.equal(err.code, "CDSE_AUTH"); // consumers (s1/terrain) branch on this code
  assert.match(err.message, /HTTP 403/);
  assert.match(err.message, /Invalid or expired account/);
  assert.match(err.message, /no active plan\/trial/);
  // An account problem must not blame the client credentials.
  assert.doesNotMatch(err.message, /Check CDSE_CLIENT_ID/);
});

test("mapCdseStatus surfaces the catalogue description (top-level shape)", () => {
  const err = mapCdseStatus(403, JSON.stringify({ code: 403, description: "Invalid or expired account." }));
  assert.equal(err.code, "CDSE_AUTH");
  assert.match(err.message, /Invalid or expired account/);
});

test("mapCdseStatus names invalid_client from the token endpoint", () => {
  const err = mapCdseStatus(
    401,
    JSON.stringify({ error: "invalid_client", error_description: "Invalid client secret" }),
  );
  assert.equal(err.code, "CDSE_AUTH");
  assert.match(err.message, /invalid_client/);
  assert.match(err.message, /Invalid client secret/);
  assert.match(err.message, /CDSE_CLIENT_ID \/ CDSE_CLIENT_SECRET/);
});

test("mapCdseStatus keeps the generic credentials hint when there is no detail", () => {
  const err = mapCdseStatus(401);
  assert.equal(err.status, 502);
  assert.equal(err.code, "CDSE_AUTH");
  assert.equal(
    err.message,
    "Copernicus authentication failed. Check CDSE_CLIENT_ID / CDSE_CLIENT_SECRET.",
  );
});

test("mapCdseStatus splits 429 rate limit from quota exhaustion, and truncates generic bodies", () => {
  // A bare 429 is the per-minute rate limit — retryable upstream.
  const rate = mapCdseStatus(429);
  assert.equal(rate.code, "CDSE_RATE_LIMIT");
  assert.match(rate.message, /rate limit/i);
  assert.doesNotMatch(rate.message, /quota/i);
  // A 429 that names the processing units is quota exhaustion — no retry.
  const quota429 = mapCdseStatus(429, JSON.stringify({ message: "Your processing units have been exhausted" }));
  assert.equal(quota429.code, "CDSE_QUOTA");
  assert.match(quota429.message, /exhausted/);
  assert.doesNotMatch(quota429.message, /retrying/i);
  // 402 is quota exhaustion, distinct from the rate limit.
  assert.equal(mapCdseStatus(402).code, "CDSE_QUOTA");
  const upstream = mapCdseStatus(503, "<html>upstream boom</html>");
  assert.equal(upstream.code, "CDSE_UPSTREAM");
  assert.match(upstream.message, /upstream boom/);
});

test("mapCdseStatus turns a Process API 400 into the parameter + violation (no raw JSON)", () => {
  // The exact COMMON_BAD_PAYLOAD shape from a 4096-px output rejection.
  const err = mapCdseStatus(
    400,
    JSON.stringify({
      error: {
        status: 400,
        reason: "Bad Request",
        message: "Invalid request",
        code: "COMMON_BAD_PAYLOAD",
        errors: [
          {
            parameter: "output->width",
            invalidValue: 4096,
            violation: "must be less than or equal to 2500",
          },
        ],
      },
    }),
  );
  assert.equal(err.code, "CDSE_BAD_REQUEST");
  assert.equal(err.status, 400);
  assert.match(err.message, /output->width/);
  assert.match(err.message, /4096/);
  assert.match(err.message, /must be less than or equal to 2500/);
  // The UI shows the human line, never the raw upstream JSON.
  assert.doesNotMatch(err.message, /\{"error"/);
  // No violation list → still a clear, non-raw message.
  const bare = mapCdseStatus(400, JSON.stringify({ error: { message: "Invalid request" } }));
  assert.equal(bare.code, "CDSE_BAD_REQUEST");
  assert.match(bare.message, /Invalid request/);
  assert.doesNotMatch(bare.message, /\{"error"/);
});

test("sanitizeCredential trims whitespace and strips surrounding quotes", () => {
  assert.equal(sanitizeCredential("  abc-123  "), "abc-123");
  assert.equal(sanitizeCredential('"abc-123"'), "abc-123");
  assert.equal(sanitizeCredential("'abc-123'"), "abc-123");
  assert.equal(sanitizeCredential('" abc-123 "'), "abc-123");
  assert.equal(sanitizeCredential(undefined), "");
  assert.equal(sanitizeCredential(""), "");
  assert.equal(sanitizeCredential('""'), "");
  // An unpaired quote is data, not a wrapper.
  assert.equal(sanitizeCredential('"abc'), '"abc');
});
