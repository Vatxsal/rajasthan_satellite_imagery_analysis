/**
 * Session JWTs — signed with HS256 via `jose` (Edge-compatible, so the same
 * code verifies cookies in middleware.ts and in Node route handlers).
 *
 * Claims: role ("guest" | "sso"), subject (guest id or username), display
 * name, issued-at and expiry. The cookie is httpOnly, SameSite=Lax, path "/"
 * and Secure in production — set through the helpers below, which return plain
 * option objects so both `cookies().set()` (routes) and NextResponse.cookies
 * (middleware) can consume them without importing next/headers here.
 */
import { SignJWT, jwtVerify } from "jose";
import { AUTH_COOKIE } from "./config";

export { AUTH_COOKIE };

export type SessionRole = "guest" | "sso";

export interface SessionClaims {
  role: SessionRole;
  /** Guest id (`guest:<uuid>`) or the SSO username. Server-side only —
   * GET /api/auth/session returns { role, name } and never this. */
  sub: string;
  /** Display name shown in the UI ("Guest" / displayName / username). */
  name: string;
  /** Seconds since epoch (NumericDate). */
  iat: number;
  exp: number;
}

export interface SignSessionInput {
  role: SessionRole;
  sub: string;
  name: string;
}

const encoder = new TextEncoder();

function isSecureCookie(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Signs a session token valid for `ttlSeconds` from now. */
export async function signSession(
  input: SignSessionInput,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return await new SignJWT({ role: input.role, name: input.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.sub)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + Math.floor(ttlSeconds))
    .sign(encoder.encode(secret));
}

/**
 * Verifies signature + expiry and shape-checks every claim.
 * Returns null for anything invalid (missing, expired, tampered, wrong
 * secret, unexpected role) — callers treat null as "not signed in".
 */
export async function verifySession(
  token: string | undefined | null,
  secret: string | null,
): Promise<SessionClaims | null> {
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      algorithms: ["HS256"],
    });
    const { role, sub, name, iat, exp } = payload;
    if (role !== "guest" && role !== "sso") return null;
    if (typeof sub !== "string" || sub.length === 0 || sub.length > 128) return null;
    if (typeof name !== "string" || name.length === 0 || name.length > 128) return null;
    if (typeof iat !== "number" || typeof exp !== "number") return null;
    return { role, sub, name, iat, exp };
  } catch {
    return null;
  }
}

/** Cookie attributes for a fresh session (maxAge in seconds). */
export function sessionCookieOptions(ttlSeconds: number): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: number;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureCookie(),
    maxAge: Math.max(0, Math.floor(ttlSeconds)),
  };
}

/** Cookie attributes that expire the session immediately (sign-out). */
export function clearSessionCookieOptions(): {
  httpOnly: true;
  sameSite: "lax";
  path: "/";
  secure: boolean;
  maxAge: 0;
  expires: Date;
} {
  return {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: isSecureCookie(),
    maxAge: 0,
    expires: new Date(0),
  };
}
