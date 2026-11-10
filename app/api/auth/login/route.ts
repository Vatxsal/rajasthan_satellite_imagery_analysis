import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { AUTH_COOKIE, sessionSecret } from "@/lib/auth/config";
import { loginLockoutGuard, recordLoginFailure, resetUsernameFailures } from "@/lib/auth/limits";
import { verifyPassword } from "@/lib/auth/passwords";
import { sessionCookieOptions, signSession } from "@/lib/auth/session";
import { findUserByName, normalizeUsername, parseSsoUsers } from "@/lib/auth/users";
import { getServerEnv } from "@/lib/env";
import { getClientIp } from "@/lib/rateLimit";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
  jsonError,
} from "@/lib/server/api";
import { turnstileEnabled, verifyTurnstile } from "@/lib/server/turnstile";

export const runtime = "nodejs";

const AUTH_BODY_LIMIT = 8_000;

const loginBodySchema = z.object({
  username: z.string().trim().min(1, "Username is required.").max(64),
  // Passwords are never trimmed — trailing spaces are significant.
  password: z.string().min(1, "Password is required.").max(256),
  turnstileToken: z.string().max(4_096).optional(),
});

/**
 * POST /api/auth/login — shared-credential SSO sign-in.
 *
 * Guards: same-origin, per-minute api bucket, optional Turnstile (fail
 * closed), lockout (5 failures / 15 min per IP and per username → 429 with
 * Retry-After), then a scrypt verification that ALWAYS runs — even for
 * unknown usernames (dummy hash) — so timing cannot enumerate users.
 * Every credential failure answers the same 401 INVALID_CREDENTIALS.
 * Success sets the session cookie and returns { role: "sso", name }.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const apiGuard = rateLimitGuard(request, "api");
  if (apiGuard) return apiGuard;
  try {
    const env = getServerEnv();
    const secret = sessionSecret(env);
    if (!secret) {
      // Fail closed: missing/short SESSION_SECRET (gate on or off) — sessions
      // cannot be signed. Dev-only detail never names the secret itself.
      throw Object.assign(
        apiError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured."),
        { detail: "SESSION_SECRET is missing or shorter than 32 characters." },
      );
    }

    const body = await readJsonBody(request, (raw) => loginBodySchema.parse(raw), AUTH_BODY_LIMIT);
    const ip = getClientIp(request);
    const username = normalizeUsername(body.username);

    if (turnstileEnabled()) {
      const captchaOk = await verifyTurnstile(body.turnstileToken, ip);
      if (!captchaOk) {
        throw apiError(403, "AUTH_CAPTCHA_FAILED", "Captcha verification failed. Try again.");
      }
    }

    const lockout = loginLockoutGuard(ip, username);
    if (!lockout.ok) {
      return NextResponse.json(
        {
          code: "AUTH_RATE_LIMITED",
          message: `Too many attempts. Try again in ${lockout.retryAfterSeconds}s.`,
        },
        { status: 429, headers: { "Retry-After": String(lockout.retryAfterSeconds) } },
      );
    }

    const parsedUsers = parseSsoUsers(env.SSO_USERS);
    if (parsedUsers.error !== null) {
      throw Object.assign(
        apiError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured."),
        { detail: parsedUsers.error },
      );
    }

    const user = findUserByName(parsedUsers.users, username);
    // Always run one scrypt derivation: unknown usernames take the dummy-hash
    // path inside verifyPassword (same work, always false), so a valid and an
    // invalid username cost the same and timing cannot enumerate users.
    const passwordOk = user
      ? verifyPassword(body.password, user.passwordHash)
      : verifyPassword(body.password, "");

    if (!user || !passwordOk) {
      recordLoginFailure(ip, username);
      return jsonError(401, "INVALID_CREDENTIALS", "Invalid username or password.");
    }

    resetUsernameFailures(username);

    const ttlSeconds = Math.floor(env.SESSION_TTL_SSO_HOURS * 3600);
    const name = user.displayName || normalizeUsername(user.username);
    const token = await signSession(
      { role: "sso", sub: normalizeUsername(user.username), name },
      secret,
      ttlSeconds,
    );
    cookies().set(AUTH_COOKIE, token, sessionCookieOptions(ttlSeconds));
    return NextResponse.json({ role: "sso", name });
  } catch (error) {
    return errorResponse(error);
  }
}
