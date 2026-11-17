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

test("mapCdseStatus still maps quota statuses and truncates generic bodies", () => {
  assert.equal(mapCdseStatus(429).code, "CDSE_QUOTA");
  assert.equal(mapCdseStatus(402).code, "CDSE_QUOTA");
  const upstream = mapCdseStatus(503, "<html>upstream boom</html>");
  assert.equal(upstream.code, "CDSE_UPSTREAM");
  assert.match(upstream.message, /upstream boom/);
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
