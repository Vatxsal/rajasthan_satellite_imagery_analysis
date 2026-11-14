/**
 * Request-level role guard for API route handlers (Node runtime).
 *
 * Three entry points, all built on one session resolution:
 *   authorize(request)            → AuthzContext | NextResponse(401)
 *   requireCapability(request, c) → NextResponse | null
 *       401 without a session, 403 FORBIDDEN_ROLE when the role lacks the
 *       capability, 429 + Retry-After when the capability is metered and the
 *       role's daily quota is spent (session AND IP counters — quota.ts).
 *   consumeRoleQuota(auth, kind)  → NextResponse | null (429 only, for routes
 *       that must validate their body before burning a quota unit).
 *
 * Session resolution: valid rse_session cookie → its role; otherwise, when
 * the auth gate is OFF (AUTH_REQUIRED=false, dev/CI) an ambient guest context
 * keeps today's behaviour of "everything works, as a guest"; when the gate is
 * ON a missing/invalid cookie is 401 UNAUTHENTICATED (same body as
 * middleware.ts). SSO_USERS carries no role — the role is the JWT claim.
 *
 * 403 body contract (consumed by the UI's locked-feature popover):
 *   { code: "FORBIDDEN_ROLE", message: "Sign in with an SSO ID to use this",
 *     required: "<role that holds it>" }
 */
import { NextResponse } from "next/server";
import { getClientIp } from "../rateLimit";
import { authGateState, AUTH_COOKIE, sessionSecret } from "./config";
import {
  can,
  limitsFor,
  PERMISSIONS,
  QUOTA_BY_CAPABILITY,
  rolesWithCapability,
  type Capability,
  type QuotaKind,
  type Role,
  type RoleLimits,
} from "./permissions";
import { consumeQuota, limitForKind } from "./quota";
import { verifySession } from "./session";

export interface AuthzContext {
  role: Role;
  /** Session subject (`guest:<uuid>` / SSO username / "guest:anonymous"). */
  sub: string;
  ip: string;
  limits: RoleLimits;
}

/** Reads the session cookie from a plain Request (works in unit tests). */
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

function unauthenticated(): NextResponse {
  return NextResponse.json(
    { code: "UNAUTHENTICATED", message: "Not signed in." },
    { status: 401, headers: { "cache-control": "no-store" } },
  );
}

/** The role that holds a capability (docs/UI derive `required` from this too). */
export function roleRequiredFor(capability: Capability): Role {
  return rolesWithCapability(capability)[0] ?? "sso";
}

/** 403 FORBIDDEN_ROLE — the exact body the locked-feature popover parses. */
export function forbiddenRoleResponse(capability: Capability): NextResponse {
  return NextResponse.json(
    {
      code: "FORBIDDEN_ROLE",
      message: "Sign in with an SSO ID to use this",
      required: roleRequiredFor(capability),
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

/** 403 for a zoom above the role's tile cap (same contract as a capability). */
export function forbiddenZoomResponse(zoom: number): NextResponse {
  const required =
    (Object.keys(PERMISSIONS) as Role[]).find((role) => limitsFor(role).tileZoomMax >= zoom) ?? "sso";
  return NextResponse.json(
    {
      code: "FORBIDDEN_ROLE",
      message: "Sign in with an SSO ID to use this",
      required,
    },
    { status: 403, headers: { "cache-control": "no-store" } },
  );
}

const QUOTA_LABELS: Record<QuotaKind, string> = {
  search: "search",
  compare: "analysis",
  aiSummary: "AI summary",
};

function quotaExceededResponse(kind: QuotaKind, limit: number, retryAfterSeconds: number): NextResponse {
  return NextResponse.json(
    {
      code: "ROLE_QUOTA_EXCEEDED",
      message: `Daily ${QUOTA_LABELS[kind]} limit reached (${limit}/day). Resets at 00:00 UTC.`,
      limit,
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds), "cache-control": "no-store" },
    },
  );
}

/** Reverse of QUOTA_BY_CAPABILITY (which capability meters a quota kind). */
const KIND_CAPABILITY = Object.entries(QUOTA_BY_CAPABILITY).reduce(
  (acc, [capability, kind]) => {
    if (kind) acc[kind] = capability as Capability;
    return acc;
  },
  {} as Partial<Record<QuotaKind, Capability>>,
);

/**
 * Resolves the caller's role context.
 * 401 when the gate is on and no valid session cookie exists; ambient guest
 * when the gate is off (dev/CI opt-out — same fallback as GET /api/auth/session).
 */
export async function authorize(request: Request): Promise<AuthzContext | NextResponse> {
  const claims = await verifySession(readSessionCookie(request), sessionSecret());
  const ip = getClientIp(request);
  if (claims) return { role: claims.role, sub: claims.sub, ip, limits: limitsFor(claims.role) };
  if (authGateState() === "off") {
    return { role: "guest", sub: "guest:anonymous", ip, limits: limitsFor("guest") };
  }
  return unauthenticated();
}

/**
 * 401 without a session → 403 FORBIDDEN_ROLE when the role lacks the
 * capability →, for metered capabilities (scenes.search / compare.analyses /
 * ai.summary), one quota unit from BOTH the session and IP counters with a
 * 429 + Retry-After when either budget is spent for the UTC day.
 * Returns null when the request may proceed.
 */
export async function requireCapability(
  request: Request,
  capability: Capability,
): Promise<NextResponse | null> {
  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;
  if (!can(auth.role, capability)) return forbiddenRoleResponse(capability);
  const kind = QUOTA_BY_CAPABILITY[capability];
  if (kind) return consumeRoleQuota(auth, kind);
  return null;
}

/**
 * Consumes one daily quota unit for an already-authorised request (routes
 * that validate their body first use this instead of the metered
 * requireCapability path). Checks the kind's capability, then the counters.
 */
export function consumeRoleQuota(auth: AuthzContext, kind: QuotaKind): NextResponse | null {
  const capability = KIND_CAPABILITY[kind];
  if (capability && !can(auth.role, capability)) return forbiddenRoleResponse(capability);
  const limit = limitForKind(auth.limits, kind);
  const result = consumeQuota(kind, { sub: auth.sub, ip: auth.ip }, limit);
  if (!result.ok) return quotaExceededResponse(kind, limit, result.retryAfterSeconds);
  return null;
}
