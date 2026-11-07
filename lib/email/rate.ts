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
 *
 * Fixed-recipient mode (EMAIL_FIXED_RECIPIENT): every send targets the same
 * mailbox, so the per-address limit is raised to the deployment cap — the
 * per-IP limit and the global cap stay the real binders.
 */
export function emailDailyGuard(input: { ip: string; addressHash: string }): EmailDailyGuardResult {
  const env = getServerEnv();
  const now = Date.now();
  const day = utcDay(now);
  const retryAfterSeconds = secondsUntilUtcMidnight(now);
  const perAddressLimit = env.EMAIL_FIXED_RECIPIENT
    ? env.EMAIL_DAILY_CAP
    : env.EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY;

  if (peek(state, "global", day) >= env.EMAIL_DAILY_CAP) {
    return { ok: false, retryAfterSeconds };
  }
  if (peek(state, `ip:${input.ip}`, day) >= env.EMAIL_RATE_LIMIT_PER_IP_PER_DAY) {
    return { ok: false, retryAfterSeconds };
  }
  if (peek(state, `addr:${input.addressHash}`, day) >= perAddressLimit) {
    return { ok: false, retryAfterSeconds };
  }

  bump(state, "global", now);
  bump(state, `ip:${input.ip}`, now);
  bump(state, `addr:${input.addressHash}`, now);
  return { ok: true, retryAfterSeconds: 0 };
}

/** True when today's deployment-wide EMAIL_DAILY_CAP is already exhausted. */
export function emailDailyCapReached(): boolean {
  const env = getServerEnv();
  return peek(state, "global", utcDay(Date.now())) >= env.EMAIL_DAILY_CAP;
}

/**
 * User-facing 429 message: the next quota reset is UTC midnight, which is
 * 05:30 IST — computed from the rollover instant so the clock time always
 * matches the window even if the window logic ever changes.
 */
export function dailyLimitMessage(retryAfterSeconds: number): string {
  const resetAt = new Date(Date.now() + retryAfterSeconds * 1000);
  const istTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(resetAt);
  return `Daily limit reached; try again after ${istTime} IST.`;
}
