import assert from "node:assert/strict";
import test from "node:test";
import { dailyLimitMessage, emailDailyGuard } from "../lib/email/rate";

/** Daily email quotas (per-address → per-IP → deployment cap). The state is
 *  a globalThis Map and getServerEnv() caches, so each case resets both and
 *  pins the env limits it needs. */

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.emailDaily"?: Map<string, unknown>;
}

function resetEnvCache(): void {
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
}

function clearDaily(): void {
  (globalThis as unknown as EnvHolder)["rse.emailDaily"]?.clear();
}

function setLimits(perAddress: number, perIp: number, dailyCap: number): void {
  process.env.EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY = String(perAddress);
  process.env.EMAIL_RATE_LIMIT_PER_IP_PER_DAY = String(perIp);
  process.env.EMAIL_DAILY_CAP = String(dailyCap);
  resetEnvCache();
}

function cleanEnv(): void {
  delete process.env.EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY;
  delete process.env.EMAIL_RATE_LIMIT_PER_IP_PER_DAY;
  delete process.env.EMAIL_DAILY_CAP;
  delete process.env.EMAIL_FIXED_RECIPIENT;
  resetEnvCache();
}

test.afterEach(() => {
  cleanEnv();
  clearDaily();
});

test("per-address quota blocks the third send from one mailbox", () => {
  setLimits(2, 10, 10);
  const input = { ip: "203.0.113.1", addressHash: "a".repeat(32) };
  assert.equal(emailDailyGuard(input).ok, true);
  assert.equal(emailDailyGuard(input).ok, true);
  const blocked = emailDailyGuard(input);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterSeconds >= 1, "retryAfter until UTC midnight");
});

test("per-IP quota blocks a second mailbox from the same host", () => {
  setLimits(10, 2, 10);
  const ip = "203.0.113.2";
  assert.equal(emailDailyGuard({ ip, addressHash: "b".repeat(32) }).ok, true);
  assert.equal(emailDailyGuard({ ip, addressHash: "c".repeat(32) }).ok, true);
  const blocked = emailDailyGuard({ ip, addressHash: "d".repeat(32) });
  assert.equal(blocked.ok, false);
  // A different host still has budget — the block is IP-scoped.
  assert.equal(emailDailyGuard({ ip: "203.0.113.3", addressHash: "e".repeat(32) }).ok, true);
});

test("deployment cap blocks every mailbox once exhausted", () => {
  setLimits(10, 10, 2);
  assert.equal(emailDailyGuard({ ip: "203.0.113.4", addressHash: "f".repeat(32) }).ok, true);
  assert.equal(emailDailyGuard({ ip: "203.0.113.5", addressHash: "g".repeat(32) }).ok, true);
  const blocked = emailDailyGuard({ ip: "203.0.113.6", addressHash: "h".repeat(32) });
  assert.equal(blocked.ok, false);
});

test("the deployment cap is checked before per-IP and per-address", () => {
  // Cap of 1 with otherwise-generous limits: the second caller is blocked by
  // the global budget even though both its own buckets are fresh.
  setLimits(10, 10, 1);
  assert.equal(emailDailyGuard({ ip: "203.0.113.7", addressHash: "i".repeat(32) }).ok, true);
  const blocked = emailDailyGuard({ ip: "203.0.113.8", addressHash: "j".repeat(32) });
  assert.equal(blocked.ok, false);
});

test("counts reset on the next UTC day", () => {
  setLimits(1, 10, 10);
  const input = { ip: "203.0.113.9", addressHash: "k".repeat(32) };
  assert.equal(emailDailyGuard(input).ok, true);
  assert.equal(emailDailyGuard(input).ok, false);

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 25 * 60 * 60 * 1000;
    assert.equal(emailDailyGuard(input).ok, true, "new UTC day starts fresh");
  } finally {
    Date.now = realNow;
  }
});

test("a blocked attempt does not consume budget", () => {
  setLimits(1, 10, 10);
  const input = { ip: "203.0.113.10", addressHash: "l".repeat(32) };
  assert.equal(emailDailyGuard(input).ok, true);
  assert.equal(emailDailyGuard(input).ok, false);
  assert.equal(emailDailyGuard(input).ok, false, "still blocked, still not consuming");

  // Raise the address limit to 3: the mailbox had consumed exactly 1 (the
  // blocked attempts added nothing), so it gets two more sends before the
  // counter reaches 3. Had retries consumed budget it would be blocked now.
  setLimits(3, 10, 10);
  assert.equal(emailDailyGuard(input).ok, true);
  assert.equal(emailDailyGuard(input).ok, true);
  assert.equal(emailDailyGuard(input).ok, false, "count reached the limit of 3");
});

test("fixed-recipient mode raises the per-address limit to the deployment cap", () => {
  // One mailbox receives every report: without the raise, the per-address
  // limit of 1 would block the second send before the cap ever mattered.
  process.env.EMAIL_FIXED_RECIPIENT = "chief@example.org";
  setLimits(1, 10, 3);
  const input = { ip: "203.0.113.11", addressHash: "m".repeat(32) };
  assert.equal(emailDailyGuard(input).ok, true);
  assert.equal(emailDailyGuard(input).ok, true, "per-address limit lifted to the cap");
  assert.equal(emailDailyGuard(input).ok, true, "third send still inside the cap");
  const blocked = emailDailyGuard(input);
  assert.equal(blocked.ok, false, "deployment cap is now the binder");
  assert.ok(blocked.retryAfterSeconds >= 1, "retryAfter until UTC midnight");
});

test("dailyLimitMessage states the 05:30 IST reset", () => {
  setLimits(1, 10, 10);
  const input = { ip: "203.0.113.12", addressHash: "n".repeat(32) };
  assert.equal(emailDailyGuard(input).ok, true, "first send consumes the budget");
  const blocked = emailDailyGuard(input);
  assert.equal(blocked.ok, false);
  assert.equal(
    dailyLimitMessage(blocked.retryAfterSeconds),
    "Daily limit reached; try again after 05:30 IST.",
    "UTC midnight is a fixed 05:30 in IST (no DST)",
  );
});
