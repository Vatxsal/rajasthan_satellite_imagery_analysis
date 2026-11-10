import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, sessionSecret } from "@/lib/auth/config";
import { verifySession } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env";
import { jsonError } from "@/lib/server/api";

export const runtime = "nodejs";

/**
 * GET /api/auth/session — the signed-in view for the UI: { role, name }.
 * 401 UNAUTHENTICATED when there is no valid session. Never returns the
 * subject, the token, or anything derived from SESSION_SECRET / SSO_USERS.
 */
export async function GET(): Promise<Response> {
  try {
    const token = cookies().get(AUTH_COOKIE)?.value;
    const secret = sessionSecret(getServerEnv());
    const claims = await verifySession(token, secret);
    if (!claims) {
      return jsonError(401, "UNAUTHENTICATED", "Not signed in.");
    }
    return NextResponse.json({ role: claims.role, name: claims.name });
  } catch {
    // Invalid environment configuration (e.g. malformed CDSE keys) must not
    // leak details through the session endpoint.
    return jsonError(401, "UNAUTHENTICATED", "Not signed in.");
  }
}
