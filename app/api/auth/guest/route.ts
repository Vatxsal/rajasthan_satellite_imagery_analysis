import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AUTH_COOKIE, sessionSecret } from "@/lib/auth/config";
import { guestVisitGuard } from "@/lib/auth/limits";
import { sessionCookieOptions, signSession } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env";
import { getClientIp } from "@/lib/rateLimit";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  sameOriginGuard,
} from "@/lib/server/api";
import { turnstileEnabled, verifyTurnstile } from "@/lib/server/turnstile";

export const runtime = "nodejs";

const AUTH_BODY_LIMIT = 8_000;

const guestBodySchema = z.object({
  turnstileToken: z.string().max(4_096).optional(),
});

/**
 * POST /api/auth/guest — issues an anonymous session (role "guest").
 *
 * Guards: same-origin, per-minute api bucket, optional Turnstile (fail
 * closed), then AUTH_GUEST_PER_IP_PER_HOUR per IP (429 + Retry-After when
 * spent). The subject is a random UUID (`guest:<uuid>`); guest sessions
 * carry no personal data. Responds { role: "guest", name: "Guest" }.
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
      throw Object.assign(
        apiError(503, "AUTH_NOT_CONFIGURED", "Authentication is not configured."),
        { detail: "SESSION_SECRET is missing or shorter than 32 characters." },
      );
    }
    if (!env.GUEST_ENABLED) {
      throw apiError(403, "GUEST_DISABLED", "Guest access is disabled on this deployment.");
    }

    // An empty body is allowed (POST with no payload) — the form never needs
    // more than the optional Turnstile token.
    const text = await request.text();
    if (text.length > AUTH_BODY_LIMIT) {
      throw apiError(413, "PAYLOAD_TOO_LARGE", `Request body too large (limit ${AUTH_BODY_LIMIT} bytes).`);
    }
    let raw: unknown = {};
    if (text.trim().length > 0) {
      try {
        raw = JSON.parse(text);
      } catch {
        throw apiError(400, "INVALID_JSON", "Request body must be valid JSON.");
      }
    }
    const body = guestBodySchema.parse(raw);
    const ip = getClientIp(request);

    if (turnstileEnabled()) {
      const captchaOk = await verifyTurnstile(body.turnstileToken, ip);
      if (!captchaOk) {
        throw apiError(403, "AUTH_CAPTCHA_FAILED", "Captcha verification failed. Try again.");
      }
    }

    const quota = guestVisitGuard(ip);
    if (!quota.ok) {
      return NextResponse.json(
        {
          code: "AUTH_RATE_LIMITED",
          message: `Guest access limit reached. Try again in ${quota.retryAfterSeconds}s.`,
        },
        { status: 429, headers: { "Retry-After": String(quota.retryAfterSeconds) } },
      );
    }

    const ttlSeconds = Math.floor(env.SESSION_TTL_GUEST_HOURS * 3600);
    const token = await signSession(
      { role: "guest", sub: `guest:${randomUUID()}`, name: "Guest" },
      secret,
      ttlSeconds,
    );
    cookies().set(AUTH_COOKIE, token, sessionCookieOptions(ttlSeconds));
    return NextResponse.json({ role: "guest", name: "Guest" });
  } catch (error) {
    return errorResponse(error);
  }
}
