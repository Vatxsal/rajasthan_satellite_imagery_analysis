import type { Role } from "@/lib/auth/permissions";
import type { ServerEnv } from "@/lib/env";
import {
  supabaseRepository,
  type QueryRepository,
  type QueryStore,
  type SupabaseConnection,
} from "@/lib/queries/repository";

/**
 * Server-only Supabase wiring for saved queries.
 *
 * The service-role key is read from the env here and handed straight to the
 * repository — it never crosses a response body, and nothing in this module
 * may be imported by client components (the browser asks GET /api/queries/config
 * which store it should use instead).
 *
 * Store selection (per session):
 *   guest               → always "local" (browser storage, cap 5)
 *   SSO + SAVED_QUERIES_STORE=local    → browser storage keyed by username
 *   SSO + SAVED_QUERIES_STORE=supabase → this table; missing env = loud 503
 *   SAVED_QUERIES_STORE=auto (default) → Supabase when URL + key are both set
 */

type SavedQueriesEnv = Pick<
  ServerEnv,
  "SAVED_QUERIES_STORE" | "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY"
>;

/** true when a Supabase project URL and server-side key are both configured. */
export function supabaseConfigured(env: SavedQueriesEnv): boolean {
  return Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/**
 * Which store this session must use.
 * Throws when SAVED_QUERIES_STORE=supabase but the env is incomplete — the
 * caller turns that into a 503 SUPABASE_NOT_CONFIGURED (never a silent
 * downgrade that would strand queries in a different place).
 */
export function resolveQueriesStore(env: SavedQueriesEnv, role: Role): QueryStore {
  if (role === "guest") return "local";
  if (env.SAVED_QUERIES_STORE === "local") return "local";
  if (env.SAVED_QUERIES_STORE === "supabase") {
    if (!supabaseConfigured(env)) {
      throw new Error(
        "SAVED_QUERIES_STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
      );
    }
    return "supabase";
  }
  // auto: Supabase when configured, otherwise this browser.
  return supabaseConfigured(env) ? "supabase" : "local";
}

/** Trims the configured connection. Throws when called without configuration. */
export function supabaseConnection(env: SavedQueriesEnv): SupabaseConnection {
  if (!supabaseConfigured(env)) {
    throw new Error(
      "SAVED_QUERIES_STORE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }
  return {
    url: (env.SUPABASE_URL as string).trim(),
    serviceRoleKey: (env.SUPABASE_SERVICE_ROLE_KEY as string).trim(),
  };
}

/**
 * Owner-scoped repository for a server route. The owner is ALWAYS the session
 * subject (`auth.sub`) — never a client-supplied value.
 */
export function queriesRepositoryFor(
  env: SavedQueriesEnv,
  owner: string,
  limit: number,
): QueryRepository {
  return supabaseRepository(supabaseConnection(env), owner, { limit });
}
