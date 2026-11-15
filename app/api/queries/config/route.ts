import { NextResponse } from "next/server";
import { authorize } from "@/lib/auth/guard";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { getServerEnv } from "@/lib/env";
import { jsonError, rateLimitGuard, type ApiErrorBody } from "@/lib/server/api";
import { resolveQueriesStore } from "@/lib/server/supabase";
import type { QueryStore } from "@/lib/queries/repository";

export const runtime = "nodejs";

export interface QueriesConfigResponse {
  store: QueryStore;
  limits: {
    /** Role of the calling session. */
    role: "guest" | "sso";
    /** This role's cap (guest 5 / SSO 50). */
    max: number;
    /** Both caps so the UI can document them without a second request. */
    guest: number;
    sso: number;
  };
}

/**
 * Tells the client where saved queries persist for THIS session — no secrets,
 * no usernames of others, cache-busted (store mode can change on redeploy).
 * Guests always get "local"; SSO gets "supabase" only when fully configured.
 */
export async function GET(request: Request): Promise<NextResponse<QueriesConfigResponse | ApiErrorBody>> {
  const limited = rateLimitGuard(request);
  if (limited) return limited;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth as NextResponse<ApiErrorBody>;

  let store: QueryStore;
  try {
    store = resolveQueriesStore(getServerEnv(), auth.role);
  } catch (error) {
    return jsonError(
      503,
      "SUPABASE_NOT_CONFIGURED",
      error instanceof Error ? error.message : "Saved-query storage is not configured.",
    );
  }

  return NextResponse.json(
    {
      store,
      limits: {
        role: auth.role,
        max: auth.limits.savedQueriesMax,
        guest: PERMISSIONS.guest.limits.savedQueriesMax,
        sso: PERMISSIONS.sso.limits.savedQueriesMax,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
