/**
 * Auth-gate configuration — pure env parsing shared by middleware (Edge) and
 * Node route handlers. No node:crypto and no jose imports here, so both
 * runtimes can load this module safely.
 *
 * The gate has three states:
 *   off            — AUTH_REQUIRED=false (dev/test, or an explicit opt-out):
 *                    middleware lets every request through; sessions still
 *                    work when a SESSION_SECRET exists.
 *   ready          — the gate is on and a usable SESSION_SECRET (≥32 chars)
 *                    is present.
 *   misconfigured  — AUTH_REQUIRED=true but SESSION_SECRET is missing or too
 *                    short: pages fail CLOSED with a plain "Authentication is
 *                    configured" page and APIs answer 503 AUTH_NOT_CONFIGURED.
 */

/** Session cookie name (httpOnly, SameSite=Lax, path "/"). */
export const AUTH_COOKIE = "rse_session";

/** HS256 secrets shorter than this are treated as missing. */
export const SESSION_SECRET_MIN_LENGTH = 32;

export type AuthGateState = "off" | "ready" | "misconfigured";

/** Structural view of the auth-relevant env: strings from process.env, booleans from getServerEnv(). */
export interface AuthEnvLike {
  AUTH_REQUIRED?: string | boolean;
  SESSION_SECRET?: string;
}

function parseBool(raw: string | boolean | undefined, defaultValue: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  // Empty value = "set but unset" (a copied .env.example line) → fall back to
  // the default instead of silently coercing to false.
  if (normalized === "") return defaultValue;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  // Unknown token: fail towards the gate being ON in production.
  return defaultValue;
}

/** True when unauthenticated requests must be challenged (default: production only). */
export function isAuthRequired(env: AuthEnvLike = process.env as AuthEnvLike): boolean {
  return parseBool(env.AUTH_REQUIRED, process.env.NODE_ENV === "production");
}

/** The HS256 signing secret, or null when missing/short (never logged). */
export function sessionSecret(env: AuthEnvLike = process.env as AuthEnvLike): string | null {
  const raw = env.SESSION_SECRET?.trim();
  if (!raw || raw.length < SESSION_SECRET_MIN_LENGTH) return null;
  return raw;
}

/** Resolves the gate state for this process/request. */
export function authGateState(env: AuthEnvLike = process.env as AuthEnvLike): AuthGateState {
  if (!isAuthRequired(env)) return "off";
  return sessionSecret(env) ? "ready" : "misconfigured";
}
