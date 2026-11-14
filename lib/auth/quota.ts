/**
 * Daily role quotas — counters per session AND per IP, per UTC day.
 *
 * One unit is consumed from BOTH the session (`sub`) and the client-IP
 * counter; a request is allowed only while both are under the role's limit.
 * Tracking both scopes means neither opening a fresh guest session from the
 * same host nor sharing one session across hosts resets the budget.
 *
 * State lives in a globalThis singleton (lib/singleton.ts) exactly like the
 * rate-limit buckets and login counters: plain module Maps would fork per
 * route graph under `next dev` HMR / Vercel bundling.
 *
 * PER-INSTANCE CAVEAT: counters are in-memory and therefore per runtime
 * instance. A serverless deployment with several warm instances enforces the
 * limit per instance (the effective fleet-wide total can exceed it), and a
 * cold start starts from zero. That is acceptable for fairness shaping; a
 * hard global quota would need a shared store (KV/DB) behind this interface.
 * UTC-day keys make rollover automatic: a new day is a new key, and stale
 * days are pruned when the map grows.
 */
import { sharedInstance } from "../singleton";
import { QUOTA_LIMIT_KEY, type QuotaKind, type RoleLimits } from "./permissions";

export type { QuotaKind };

/** Who is being counted: the session subject and the client IP. */
export interface QuotaSubject {
  /** Session `sub` (`guest:<uuid>` / SSO username), or "guest:anonymous"
   *  when the auth gate is off and no cookie exists. */
  sub: string;
  ip: string;
}

export interface QuotaUsage {
  used: number;
  limit: number;
  remaining: number;
}

export interface QuotaResult {
  ok: boolean;
  /** Seconds until the UTC day rolls over (0 while ok). */
  retryAfterSeconds: number;
  /** Binding usage = the higher of the session and IP counters. */
  usage: QuotaUsage;
}

const PRUNE_THRESHOLD = 5_000;

interface QuotaState {
  /** Key: `<kind>|<YYYY-MM-DD>|<session|ip>|<id>` → count. */
  counts: Map<string, number>;
}

const state = sharedInstance<QuotaState>("rse.roleQuotas", () => ({ counts: new Map() }));

/**
 * Deployment-wide daily tallies for the SSO System status panel (not role
 * limits — just "how much did this instance serve today"). Same per-instance
 * caveat as the role counters above.
 */
export type GlobalCounterName = "render" | "analyze" | "ai" | "email";

interface GlobalState {
  /** Key: `<name>|<YYYY-MM-DD>` → count. */
  counts: Map<string, number>;
}

const globalState = sharedInstance<GlobalState>("rse.globalCounters", () => ({ counts: new Map() }));

/** Adds one to today's deployment counter (UTC day). */
export function bumpGlobalCounter(name: GlobalCounterName, now: number = Date.now()): void {
  const key = `${name}|${utcDay(now)}`;
  globalState.counts.set(key, (globalState.counts.get(key) ?? 0) + 1);
  if (globalState.counts.size > PRUNE_THRESHOLD) {
    const today = utcDay(now);
    for (const mapKey of globalState.counts.keys()) {
      if (!mapKey.endsWith(`|${today}`)) globalState.counts.delete(mapKey);
    }
  }
}

/** Today's deployment counters (missing kinds read as 0). */
export function readGlobalCounters(now: number = Date.now()): Record<GlobalCounterName, number> {
  const day = utcDay(now);
  const out: Record<GlobalCounterName, number> = { render: 0, analyze: 0, ai: 0, email: 0 };
  for (const name of Object.keys(out) as GlobalCounterName[]) {
    out[name] = globalState.counts.get(`${name}|${day}`) ?? 0;
  }
  return out;
}

/** Test hook: drops every counter (mirrors resetAuthLimits). */
export function resetRoleQuotas(): void {
  state.counts.clear();
  globalState.counts.clear();
}

/** The current UTC day bucket (`YYYY-MM-DD`). */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Seconds from `now` until the next UTC midnight (≥ 1). */
export function secondsUntilUtcMidnight(now: number = Date.now()): number {
  const nextMidnight = Math.floor(now / 86_400_000 + 1) * 86_400_000;
  return Math.max(1, Math.ceil((nextMidnight - now) / 1000));
}

/** The role's numeric limit for a quota kind (e.g. compare → comparePerDay). */
export function limitForKind(limits: RoleLimits, kind: QuotaKind): number {
  return limits[QUOTA_LIMIT_KEY[kind]];
}

function key(kind: QuotaKind, day: string, scope: "session" | "ip", id: string): string {
  return `${kind}|${day}|${scope}|${id}`;
}

function prune(today: string): void {
  if (state.counts.size <= PRUNE_THRESHOLD) return;
  for (const mapKey of state.counts.keys()) {
    if (!mapKey.includes(`|${today}|`)) state.counts.delete(mapKey);
  }
}

function read(kind: QuotaKind, day: string, scope: "session" | "ip", id: string): number {
  return state.counts.get(key(kind, day, scope, id)) ?? 0;
}

/** The binding (higher) usage across both scopes without consuming. */
export function quotaUsage(
  kind: QuotaKind,
  subject: QuotaSubject,
  limit: number,
  now: number = Date.now(),
): QuotaUsage {
  const day = utcDay(now);
  const used = Math.max(
    read(kind, day, "session", subject.sub),
    read(kind, day, "ip", subject.ip),
  );
  return { used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Consumes one unit from BOTH counters when both are under the limit.
 * Returns ok=false (nothing consumed) with Retry-After when either the
 * session or the IP budget is spent for the current UTC day.
 */
export function consumeQuota(
  kind: QuotaKind,
  subject: QuotaSubject,
  limit: number,
  now: number = Date.now(),
): QuotaResult {
  const day = utcDay(now);
  prune(day);

  const sessionKey = key(kind, day, "session", subject.sub);
  const ipKey = key(kind, day, "ip", subject.ip);
  const sessionUsed = state.counts.get(sessionKey) ?? 0;
  const ipUsed = state.counts.get(ipKey) ?? 0;
  const used = Math.max(sessionUsed, ipUsed);

  if (used >= limit) {
    return {
      ok: false,
      retryAfterSeconds: secondsUntilUtcMidnight(now),
      usage: { used, limit, remaining: 0 },
    };
  }

  state.counts.set(sessionKey, sessionUsed + 1);
  state.counts.set(ipKey, ipUsed + 1);
  const nextUsed = used + 1;
  return {
    ok: true,
    retryAfterSeconds: 0,
    usage: { used: nextUsed, limit, remaining: Math.max(0, limit - nextUsed) },
  };
}
