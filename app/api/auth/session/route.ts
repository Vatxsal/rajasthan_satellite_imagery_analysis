import { NextResponse } from "next/server";
import { authGateState, AUTH_COOKIE, sessionSecret } from "@/lib/auth/config";
import { PERMISSIONS, limitsFor, type QuotaKind, type Role } from "@/lib/auth/permissions";
import { quotaUsage, type QuotaUsage } from "@/lib/auth/quota";
import { verifySession } from "@/lib/auth/session";
import { getServerEnv } from "@/lib/env";
import { getClientIp } from "@/lib/rateLimit";
import { jsonError } from "@/lib/server/api";

export const runtime = "nodejs";

const QUOTA_KINDS: QuotaKind[] = ["search", "compare", "aiSummary"];

/** Session cookie from a plain Request (same parser as lib/auth/guard.ts). */
function readSessionCookie(request: Request): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === AUTH_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * GET /api/auth/session — the signed-in view for the UI:
 *   { role, name, capabilities, limits, usageToday }.
 * `capabilities`/`limits` mirror lib/auth/permissions.ts (the single policy
 * source) so the client never re-implements role checks; `usageToday` is the
 * binding (session OR IP) daily quota usage for each metered kind. 401
 * UNAUTHENTICATED when there is no valid session and the auth gate is on.
 * With the gate off nobody is challenged, so the probe answers with the
 * ambient guest identity (same subject the API guards use). Never returns
 * the subject, the token, or anything derived from SESSION_SECRET / SSO_USERS.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const env = getServerEnv();
    const token = readSessionCookie(request);
    const claims = await verifySession(token, sessionSecret(env));
    const ip = getClientIp(request);

    const payload = (role: Role, name: string, sub: string) => {
      const limits = limitsFor(role);
      const subject = { sub, ip };
      const usageToday = Object.fromEntries(
        QUOTA_KINDS.map((kind) => [
          kind,
          quotaUsage(
            kind,
            subject,
            kind === "search"
              ? limits.searchesPerDay
              : kind === "compare"
                ? limits.comparePerDay
                : limits.aiSummariesPerDay,
          ),
        ]),
      ) as Record<QuotaKind, QuotaUsage>;
      return NextResponse.json(
        {
          role,
          name,
          capabilities: PERMISSIONS[role].capabilities,
          limits,
          usageToday,
        },
        { headers: { "cache-control": "no-store" } },
      );
    };

    if (claims) return payload(claims.role, claims.name, claims.sub);
    if (authGateState(env) === "off") return payload("guest", "Guest", "guest:anonymous");
    return jsonError(401, "UNAUTHENTICATED", "Not signed in.");
  } catch {
    // Invalid environment configuration (e.g. malformed CDSE keys) must not
    // leak details through the session endpoint.
    return jsonError(401, "UNAUTHENTICATED", "Not signed in.");
  }
}
