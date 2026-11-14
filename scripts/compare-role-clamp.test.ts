import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test from "node:test";

/** resolveCompareParams applies the caller's role clamp BEFORE the cache key
 *  is derived, so a guest can never recompute a cached key with tuning they
 *  are not allowed to set (that would re-hit the pipeline under a fresh key).
 *  lib/env freezes dataSource at first load, so NEXT_PUBLIC_DATA_SOURCE=cdse
 *  is set here and compareRun is imported dynamically — after the env var. */

test("role clamps sensitivity and minPatchHa before key derivation", async () => {
  // cdse mode so the mock sentinel never short-circuits the key derivation;
  // resolveCompareParams → getServerEnv() validates the CDSE credentials.
  process.env.NEXT_PUBLIC_DATA_SOURCE = "cdse";
  process.env.CDSE_CLIENT_ID = "test-client";
  process.env.CDSE_CLIENT_SECRET = "test-secret";
  const { resolveCompareParams } = await import("../lib/server/compareRun");

  const raw = {
    areaId: "d-jaisalmer",
    level: "district" as const,
    dateA: "2026-01-01",
    dateB: "2026-01-20",
    sensitivity: "high" as const,
    minPatchHa: 7,
  };

  const guest = resolveCompareParams(raw, { role: "guest" });
  assert.equal(guest.sensitivity, "medium");
  assert.equal(guest.minPatchHa, 0.2);

  const sso = resolveCompareParams(raw, { role: "sso" });
  assert.equal(sso.sensitivity, "high");
  assert.equal(sso.minPatchHa, 7);

  // The clamped guest key equals the default-tuning key (clamps happen
  // before derivation), and differs from the unclamped SSO key.
  const guestDefaults = resolveCompareParams(
    { ...raw, sensitivity: "medium", minPatchHa: 0.2 },
    { role: "guest" },
  );
  assert.equal(guest.key, guestDefaults.key);
  assert.notEqual(guest.key, sso.key);
});
