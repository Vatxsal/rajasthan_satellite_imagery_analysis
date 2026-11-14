/**
 * Shared session forging for route tests (compiled into the test build via
 * tsconfig.test.json). Route handlers read the rse_session cookie straight
 * from the Request, so tests sign a real JWT with a known secret and attach
 * it as a header — no server boot, no next/headers.
 */
import { AUTH_COOKIE, signSession } from "../lib/auth/session";

/** ≥32 chars so sessionSecret() accepts it (mirrors auth-session.test.ts). */
export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef0123456789abcdef";

/** Puts the auth gate into the "ready" state (valid secret, challenges 401). */
export function useReadyAuthGate(): void {
  process.env.AUTH_REQUIRED = "true";
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
}

/** Gate off: requests without a cookie become the ambient guest context. */
export function useOpenAuthGate(): void {
  delete process.env.AUTH_REQUIRED;
  delete process.env.SESSION_SECRET;
}

async function forge(role: "guest" | "sso", sub: string, name: string): Promise<string> {
  const token = await signSession({ role, sub, name }, TEST_SESSION_SECRET, 3_600);
  return `${AUTH_COOKIE}=${token}`;
}

/** `rse_session=<jwt>` for an SSO session (cached — tokens last an hour). */
export async function ssoCookie(sub = "test-sso-user"): Promise<string> {
  return forge("sso", sub, "Test SSO");
}

/** `rse_session=<jwt>` for a guest session with a stable subject. */
export async function guestCookie(sub = "guest:00000000-0000-4000-8000-000000000099"): Promise<string> {
  return forge("guest", sub, "Guest");
}
