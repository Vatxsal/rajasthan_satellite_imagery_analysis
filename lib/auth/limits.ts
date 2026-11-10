/**
 * Auth abuse limits — login lockout and guest-session quotas.
 *
 * - Login: 5 failed attempts per key per 15-minute fixed window. Keys are
 *   separate per IP and per username, so one attacker cannot spray many
 *   usernames from one host, and one username cannot be brute-forced from
 *   many hosts. A successful login resets ONLY that username's counter —
 *   the IP counter keeps counting (per spec) so a success cannot be used to
 *   clear a half-spent IP budget.
 * - Guest: AUTH_GUEST_PER_IP_PER_HOUR guest sessions per IP per hour.
 *
 * All state lives in globalThis singletons (lib/singleton.ts): plain module
 * Maps would fork per route graph under `next dev` HMR / Vercel bundling.
 */
import { getServerEnv } from "@/lib/env";
import { sharedInstance } from "@/lib/singleton";

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_IP_LIMIT = 5;
const LOGIN_USERNAME_LIMIT = 5;
const GUEST_WINDOW_MS = 60 * 60_000;
const PRUNE_THRESHOLD = 2_000;

interface Window {
  count: number;
  resetAt: number;
}

interface AuthLimitState {
  /** Keys: `ip:<ip>` and `user:<normalized-username>`. */
  loginFailures: Map<string, Window>;
  /** Keys: `ip:<ip>`. */
  guestVisits: Map<string, Window>;
}

const state = sharedInstance<AuthLimitState>("rse.authLimits", () => ({
  loginFailures: new Map(),
  guestVisits: new Map(),
}));

/** Test hook: drops all counters (matches the reset pattern of the email tests). */
export function resetAuthLimits(): void {
  state.loginFailures.clear();
  state.guestVisits.clear();
}

function prune(map: Map<string, Window>, now: number): void {
  if (map.size <= PRUNE_THRESHOLD) return;
  for (const [key, window] of map) {
    if (window.resetAt <= now) map.delete(key);
  }
}

function peek(map: Map<string, Window>, key: string, now: number): Window | null {
  const window = map.get(key);
  if (!window || window.resetAt <= now) return null;
  return window;
}

function bump(map: Map<string, Window>, key: string, windowMs: number, now: number): void {
  const existing = peek(map, key, now);
  if (!existing) {
    map.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  existing.count += 1;
}

export interface AuthGuardResult {
  ok: boolean;
  /** Seconds until the earliest blocking window resets (0 when ok). */
  retryAfterSeconds: number;
}

function secondsUntil(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}

function userKey(normalizedUsername: string): string {
  return `user:${normalizedUsername}`;
}

function ipKey(ip: string): string {
  return `ip:${ip}`;
}

/**
 * Checks both lockout counters BEFORE any password work. Returns the
 * earliest reset when either the IP or the username is blocked.
 */
export function loginLockoutGuard(ip: string, normalizedUsername: string): AuthGuardResult {
  const now = Date.now();
  prune(state.loginFailures, now);
  let earliest: number | null = null;
  const ipWindow = peek(state.loginFailures, ipKey(ip), now);
  if (ipWindow && ipWindow.count >= LOGIN_IP_LIMIT) earliest = ipWindow.resetAt;
  const userWindow = peek(state.loginFailures, userKey(normalizedUsername), now);
  if (userWindow && userWindow.count >= LOGIN_USERNAME_LIMIT) {
    earliest = earliest === null ? userWindow.resetAt : Math.min(earliest, userWindow.resetAt);
  }
  if (earliest !== null) return { ok: false, retryAfterSeconds: secondsUntil(earliest, now) };
  return { ok: true, retryAfterSeconds: 0 };
}

/** Records one failed login against both the IP and the username. */
export function recordLoginFailure(ip: string, normalizedUsername: string): void {
  const now = Date.now();
  prune(state.loginFailures, now);
  bump(state.loginFailures, ipKey(ip), LOGIN_WINDOW_MS, now);
  bump(state.loginFailures, userKey(normalizedUsername), LOGIN_WINDOW_MS, now);
}

/** Successful login: clears ONLY the username counter (IP counter persists). */
export function resetUsernameFailures(normalizedUsername: string): void {
  state.loginFailures.delete(userKey(normalizedUsername));
}

/**
 * Consumes one guest session from the per-IP hourly budget.
 * Returns ok=false with Retry-After when the budget is spent.
 */
export function guestVisitGuard(ip: string): AuthGuardResult {
  const env = getServerEnv();
  const now = Date.now();
  prune(state.guestVisits, now);
  const limit = env.AUTH_GUEST_PER_IP_PER_HOUR;
  const existing = peek(state.guestVisits, ipKey(ip), now);
  if (existing && existing.count >= limit) {
    return { ok: false, retryAfterSeconds: secondsUntil(existing.resetAt, now) };
  }
  bump(state.guestVisits, ipKey(ip), GUEST_WINDOW_MS, now);
  return { ok: true, retryAfterSeconds: 0 };
}
