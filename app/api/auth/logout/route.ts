import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE } from "@/lib/auth/config";
import { clearSessionCookieOptions } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/server/api";

export const runtime = "nodejs";

/**
 * POST /api/auth/logout — clears the session cookie and answers { ok: true }.
 * Signing out is idempotent: an absent or expired cookie is still a success.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  cookies().set(AUTH_COOKIE, "", clearSessionCookieOptions());
  return NextResponse.json({ ok: true });
}
