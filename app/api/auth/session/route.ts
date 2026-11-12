import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, authGateState, sessionSecret } from "@/lib/auth/config";
import { verifySession } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env";
import { jsonError } from "@/lib/server/api";

export const runtime = "nodejs";

/**
 * GET /api/auth/session — the signed-in view for the UI: { role, name }.
 * 401 UNAUTHENTICATED when there is no valid session and the auth gate is
 * on. With the gate off (AUTH_REQUIRED=false) nobody is challenged, so the
 * probe answers with the ambient guest identity instead — a 401 here made
 * every signed-out page load log "Failed to load resource" in the console.
 * Never returns the subject, the token, or anything derived from
 * SESSION_SECRET / SSO_USERS.
 */
export async function GET(): Promise<Response> {
  try {
    const env = getServerEnv();
    const token = cookies().get(AUTH_COOKIE)?.value;
    const claims = await verifySession(token, sessionSecret(env));
    if (claims) {
      return NextResponse.json({ role: claims.role, name: claims.name });
    }
    if (authGateState(env) === "off") {
      return NextResponse.json({ role: "guest", name: "Guest" });
    }
    return jsonError(401, "UNAUTHENTICATED", "Not signed in.");
  } catch {
    // Invalid environment configuration (e.g. malformed CDSE keys) must not
    // leak details through the session endpoint.
    return jsonError(401, "UNAUTHENTICATED", "Not signed in.");
  }
}
