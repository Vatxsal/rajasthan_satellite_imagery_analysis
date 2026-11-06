import { getServerEnv } from "../env";
import { sharedInstance } from "../singleton";

/**
 * Daily email quotas (UTC-day fixed windows): per-address, per-IP and a
 * deployment-wide cap — all read from the EMAIL_* env fields validated in
 * lib/env.ts. In-memory per process, like lib/rateLimit.ts; a durable
 * cross-instance store (Upstash/Vercel KV) is the documented upgrade path
 * if a deployment needs limits that survive instance rotation.
 */
interface DayCount {
  day: string;
  count: number;
}

type EmailDailyState = Map<string, DayCount>;

const state = sharedInstance<EmailDailyState>("rse.emailDaily", () => new Map());

export interface EmailDailyGuardResult {
  ok: boolean;
  /** Seconds until the next UTC-day reset when blocked. */
  retryAfterSeconds: number;
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

function bump(map: EmailDailyState, key: string, now: number): DayCount {
  const day = utcDay(now);
  const existing = map.get(key);
  if (!existing || existing.day !== day) {
    const fresh: DayCount = { day, count: 1 };
    map.set(key, fresh);
    return fresh;
  }
  existing.count += 1;
  return existing;
}

function peek(map: EmailDailyState, key: string, day: string): number {
  const bucket = map.get(key);
  return bucket && bucket.day === day ? bucket.count : 0;
}

/**
 * Checks (and on success consumes) today's quota for this recipient/IP.
 * Order: deployment cap → per-IP → per-address — so a spammer cannot burn
 * the global budget through many addresses from one host, and one address
 * cannot exhaust a host's budget either.
 */
export function emailDailyGuard(input: { ip: string; addressHash: string }): EmailDailyGuardResult {
  const env = getServerEnv();
  const now = Date.now();
  const day = utcDay(now);
  const retryAfterSeconds = secondsUntilUtcMidnight(now);

  if (peek(state, "global", day) >= env.EMAIL_DAILY_CAP) {
    return { ok: false, retryAfterSeconds };
  }
  if (peek(state, `ip:${input.ip}`, day) >= env.EMAIL_RATE_LIMIT_PER_IP_PER_DAY) {
    return { ok: false, retryAfterSeconds };
  }
  if (peek(state, `addr:${input.addressHash}`, day) >= env.EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY) {
    return { ok: false, retryAfterSeconds };
  }

  bump(state, "global", now);
  bump(state, `ip:${input.ip}`, now);
  bump(state, `addr:${input.addressHash}`, now);
  return { ok: true, retryAfterSeconds: 0 };
}
