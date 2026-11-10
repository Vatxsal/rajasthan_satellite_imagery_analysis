/**
 * Abuse limits for POST /api/access-request — independent of the report
 * email quotas (EMAIL_*): a separate per-IP daily budget, a separate
 * deployment-wide daily cap, a per-requester-address limit (2/day, hashed)
 * and 10-minute duplicate suppression for identical content.
 *
 * UTC-day fixed windows, in-memory behind a globalThis singleton (same
 * pattern as lib/email/rate.ts); durable cross-instance storage is the
 * documented upgrade path if a deployment needs limits that survive cold
 * starts. The requester's address only ever appears as a hash prefix.
 */
import { createHash } from "node:crypto";
import { getServerEnv } from "@/lib/env";
import { sharedInstance } from "@/lib/singleton";

/** Per requester-address submissions per UTC day (spec: 2). */
export const ACCESS_PER_EMAIL_PER_DAY = 2;
/** Identical content is not re-sent within this window (ms). */
export const ACCESS_DEDUPE_WINDOW_MS = 10 * 60_000;

interface DayCount {
  day: string;
  count: number;
}

interface AccessState {
  /** Keys: "global", "ip:<ip>", "addr:<email-hash>". */
  counts: Map<string, DayCount>;
  /** content-key → sentAt (epoch ms). */
  recent: Map<string, number>;
}

const state = sharedInstance<AccessState>("rse.accessRequest", () => ({
  counts: new Map(),
  recent: new Map(),
}));

/** Test hook: drops all counters and the duplicate log. */
export function resetAccessRequestState(): void {
  state.counts.clear();
  state.recent.clear();
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight(now: number): number {
  const next = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1,
  );
  return Math.max(1, Math.ceil((next - now) / 1000));
}

function peek(map: Map<string, DayCount>, key: string, day: string): number {
  const bucket = map.get(key);
  return bucket && bucket.day === day ? bucket.count : 0;
}

function bump(map: Map<string, DayCount>, key: string, now: number): void {
  const day = utcDay(now);
  const existing = map.get(key);
  if (!existing || existing.day !== day) {
    map.set(key, { day, count: 1 });
    return;
  }
  existing.count += 1;
}

/** Idempotency key for duplicate suppression: normalised fields, hashed. */
export function accessContentKey(input: {
  name: string;
  company: string;
  email: string;
  reason: string;
}): string {
  const payload = [input.name, input.company, input.email, input.reason].join("\n");
  return createHash("sha256").update(`rse-access-v1:${payload}`).digest("hex").slice(0, 32);
}

/** True when identical content went out within the dedupe window. */
export function accessWasRecentlySent(contentKey: string, now = Date.now()): boolean {
  const sentAt = state.recent.get(contentKey);
  if (sentAt === undefined) return false;
  if (now - sentAt > ACCESS_DEDUPE_WINDOW_MS) {
    state.recent.delete(contentKey);
    return false;
  }
  return true;
}

export function accessMarkSent(contentKey: string, now = Date.now()): void {
  if (state.recent.size > 500) {
    for (const [key, sentAt] of state.recent) {
      if (now - sentAt > ACCESS_DEDUPE_WINDOW_MS) state.recent.delete(key);
    }
  }
  state.recent.set(contentKey, now);
}

export interface AccessGuardResult {
  ok: boolean;
  /** Seconds until the next UTC-day reset when blocked. */
  retryAfterSeconds: number;
}

/**
 * Checks (and on success consumes) today's quota: per-IP → per-address →
 * deployment cap — so one host cannot burn the global budget through many
 * addresses, and one address cannot exhaust a host's budget.
 * ACCESS_REQUEST_DAILY_CAP=0 blocks everything (feature off).
 */
export function accessDailyGuard(input: { ip: string; addressHash: string }): AccessGuardResult {
  const env = getServerEnv();
  const now = Date.now();
  const day = utcDay(now);
  const retryAfterSeconds = secondsUntilUtcMidnight(now);

  if (env.ACCESS_REQUEST_DAILY_CAP <= 0) {
    return { ok: false, retryAfterSeconds };
  }
  if (peek(state.counts, "global", day) >= env.ACCESS_REQUEST_DAILY_CAP) {
    return { ok: false, retryAfterSeconds };
  }
  if (peek(state.counts, `ip:${input.ip}`, day) >= env.ACCESS_REQUEST_PER_IP_PER_DAY) {
    return { ok: false, retryAfterSeconds };
  }
  if (peek(state.counts, `addr:${input.addressHash}`, day) >= ACCESS_PER_EMAIL_PER_DAY) {
    return { ok: false, retryAfterSeconds };
  }

  bump(state.counts, "global", now);
  bump(state.counts, `ip:${input.ip}`, now);
  bump(state.counts, `addr:${input.addressHash}`, now);
  return { ok: true, retryAfterSeconds: 0 };
}
