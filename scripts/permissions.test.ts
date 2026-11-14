import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  CAPABILITIES,
  DEFAULT_MIN_PATCH_HA,
  DEFAULT_SENSITIVITY,
  PERMISSIONS,
  QUOTA_BY_CAPABILITY,
  QUOTA_LIMIT_KEY,
  can,
  clampCompareTuning,
  exceedsSearchWindow,
  isLevelAllowed,
  limitsFor,
  policyFor,
  rolesWithCapability,
  spanDays,
  type Capability,
  type Role,
} from "../lib/auth/permissions";
import {
  consumeQuota,
  limitForKind,
  quotaUsage,
  resetRoleQuotas,
  secondsUntilUtcMidnight,
  utcDay,
} from "../lib/auth/quota";

/** Policy + quota units: the single source of truth (lib/auth/permissions.ts)
 *  and the per-UTC-day dual-scope counters (lib/auth/quota.ts). */

const ROLES: Role[] = ["guest", "sso"];

test("every declared capability resolves to a boolean for both roles", () => {
  assert.ok(CAPABILITIES.length >= 15);
  for (const capability of CAPABILITIES) {
    for (const role of ROLES) {
      assert.equal(typeof can(role, capability), "boolean", `${role} · ${capability}`);
    }
  }
});

test("only two roles exist — no admin or member role", () => {
  assert.deepEqual(Object.keys(PERMISSIONS).sort(), ["guest", "sso"]);
  assert.equal(policyFor("guest").label, "Guest");
  assert.equal(policyFor("sso").label, "SSO");
});

test("guest defaults match the brief", () => {
  const guest = policyFor("guest");
  assert.equal(guest.limits.searchWindowDays, 90);
  assert.equal(guest.limits.tileZoomMax, 12);
  assert.equal(guest.limits.searchesPerDay, 30);
  assert.equal(guest.limits.comparePerDay, 3);
  assert.equal(guest.limits.aiSummariesPerDay, 0);
  assert.equal(guest.limits.downloadMaxPx, 1024);

  // Open to guests:
  for (const capability of [
    "scenes.search",
    "compare.view",
    "compare.analyses",
    "downloads.png",
    "downloads.copernicus",
  ] as Capability[]) {
    assert.ok(can("guest", capability), capability);
  }
  // Locked for guests:
  for (const capability of [
    "compare.district",
    "compare.adjust-sensitivity",
    "compare.adjust-min-patch",
    "downloads.geotiff",
    "exports.change-map",
    "exports.csv",
    "exports.geojson",
    "exports.imagery",
    "ai.summary",
    "email.report",
    "fields.pattern",
    "system.status",
  ] as Capability[]) {
    assert.equal(can("guest", capability), false, capability);
  }
});

test("sso holds every capability and the full limits", () => {
  const sso = policyFor("sso");
  assert.equal(sso.limits.searchWindowDays, null);
  assert.equal(sso.limits.tileZoomMax, 14);
  assert.equal(sso.limits.searchesPerDay, 300);
  assert.equal(sso.limits.comparePerDay, 50);
  assert.equal(sso.limits.aiSummariesPerDay, 30);
  assert.equal(sso.limits.downloadMaxPx, 2500);
  for (const capability of CAPABILITIES) {
    assert.ok(can("sso", capability), capability);
  }
});

test("district level needs compare.district; tehsil and ILR are open to all", () => {
  assert.equal(isLevelAllowed("guest", "district"), false);
  assert.equal(isLevelAllowed("guest", "tehsil"), true);
  assert.equal(isLevelAllowed("guest", "ilr"), true);
  assert.equal(isLevelAllowed("sso", "district"), true);
});

test("search window: 90 days allowed, 91 rejected, SSO unlimited", () => {
  assert.equal(exceedsSearchWindow("guest", "2026-01-01", "2026-04-01"), false); // exactly 90
  assert.equal(exceedsSearchWindow("guest", "2026-01-01", "2026-04-02"), true); // 91
  assert.equal(exceedsSearchWindow("guest", "2026-01-02", "2026-01-01"), false); // inverted
  assert.equal(exceedsSearchWindow("sso", "2020-01-01", "2026-12-31"), false);
  assert.equal(spanDays("2026-01-01", "2026-01-31"), 30);
});

test("tuning clamp forces defaults for guests and keeps SSO values", () => {
  const guest = clampCompareTuning("guest", { sensitivity: "high", minPatchHa: 7 });
  assert.equal(guest.sensitivity, DEFAULT_SENSITIVITY);
  assert.equal(guest.minPatchHa, DEFAULT_MIN_PATCH_HA);

  const sso = clampCompareTuning("sso", { sensitivity: "high", minPatchHa: 7 });
  assert.equal(sso.sensitivity, "high");
  assert.equal(sso.minPatchHa, 7);
});

test("quota mapping: metered capabilities and their limit keys", () => {
  assert.deepEqual(QUOTA_BY_CAPABILITY, {
    "scenes.search": "search",
    "compare.analyses": "compare",
    "ai.summary": "aiSummary",
  });
  assert.equal(QUOTA_LIMIT_KEY.search, "searchesPerDay");
  assert.equal(QUOTA_LIMIT_KEY.compare, "comparePerDay");
  assert.equal(QUOTA_LIMIT_KEY.aiSummary, "aiSummariesPerDay");
  assert.equal(limitForKind(limitsFor("guest"), "compare"), 3);
  assert.equal(limitForKind(limitsFor("sso"), "aiSummary"), 30);
  assert.equal(limitForKind(limitsFor("guest"), "search"), 30);
});

test("rolesWithCapability lists the holders (docs/readout helper)", () => {
  assert.deepEqual(rolesWithCapability("email.report"), ["sso"]);
  assert.deepEqual(rolesWithCapability("system.status"), ["sso"]);
  assert.deepEqual(rolesWithCapability("downloads.png"), ["guest", "sso"]);
});

// ---------------------------------------------------------------- quotas

beforeEach(() => resetRoleQuotas());

test("consumeQuota counts both scopes up to the limit, then 429s", () => {
  const subject = { sub: "guest:a", ip: "10.0.0.1" };
  const first = consumeQuota("compare", subject, 3);
  assert.equal(first.ok, true);
  assert.equal(first.usage.used, 1);
  assert.equal(first.usage.remaining, 2);

  assert.equal(consumeQuota("compare", subject, 3).ok, true);
  assert.equal(consumeQuota("compare", subject, 3).ok, true);
  const blocked = consumeQuota("compare", subject, 3);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.usage.remaining, 0);
  assert.ok(blocked.retryAfterSeconds >= 1, "Retry-After seconds are positive");
  assert.ok(blocked.retryAfterSeconds <= 86_400, "never more than a day");
});

test("the IP scope binds across sessions; a fresh IP starts over", () => {
  const limit = 2;
  const a = { sub: "guest:a", ip: "10.0.0.1" };
  assert.equal(consumeQuota("search", a, limit).ok, true);
  assert.equal(consumeQuota("search", a, limit).ok, true);
  assert.equal(consumeQuota("search", a, limit).ok, false);
  // New session from the same host is still blocked by the IP counter…
  assert.equal(consumeQuota("search", { sub: "guest:b", ip: "10.0.0.1" }, limit).ok, false);
  // …while a different host with a fresh session is not.
  assert.equal(consumeQuota("search", { sub: "guest:b", ip: "10.0.0.2" }, limit).ok, true);
});

test("UTC-day rollover resets both counters", () => {
  const subject = { sub: "guest:roll", ip: "10.9.9.9" };
  const day1 = Date.parse("2026-06-10T12:00:00Z");
  const day2 = Date.parse("2026-06-11T00:00:01Z");
  assert.equal(consumeQuota("compare", subject, 1, day1).ok, true);
  assert.equal(consumeQuota("compare", subject, 1, day1).ok, false);
  // Next UTC day: fresh budget without any explicit reset.
  assert.equal(consumeQuota("compare", subject, 1, day2).ok, true);
  assert.equal(quotaUsage("compare", subject, 1, day2).used, 1);
});

test("quotaUsage reports the binding (higher) scope and remaining", () => {
  const subject = { sub: "guest:u", ip: "10.1.1.1" };
  consumeQuota("search", subject, 30);
  const usage = quotaUsage("search", subject, 30);
  assert.equal(usage.used, 1);
  assert.equal(usage.limit, 30);
  assert.equal(usage.remaining, 29);
});

test("utcDay is the UTC date and the midnight helper counts down to it", () => {
  const now = Date.parse("2026-06-10T23:59:30Z");
  assert.equal(utcDay(now), "2026-06-10");
  const seconds = secondsUntilUtcMidnight(now);
  assert.ok(seconds >= 30 && seconds <= 31, `got ${seconds}`);
  assert.equal(utcDay(now + 45_000), "2026-06-11");
});
