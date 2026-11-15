import { NextResponse } from "next/server";
import { authorize, type AuthzContext } from "@/lib/auth/guard";
import { getServerEnv } from "@/lib/env";
import { apiError, jsonError, rateLimitGuard } from "@/lib/server/api";
import { queriesRepositoryFor, resolveQueriesStore } from "@/lib/server/supabase";
import { resolveArea } from "@/lib/server/areas";
import {
  isQueryRepoError,
  type QueryAreaLevel,
  type QueryRepository,
} from "@/lib/queries/repository";

/** Body cap for saved-query payloads (largest legit body: 200-char description). */
export const MAX_QUERY_BODY_BYTES = 16_384;

/** Whole-state queries reserve areaId "rj" — no boundary feature exists for it. */
export const STATE_AREA_ID = "rj";

export interface QueriesContext {
  auth: AuthzContext;
  repo: QueryRepository;
}

/**
 * Shared preamble for every /api/queries route: rate limit → session →
 * store gate. Server-side persistence exists only for the Supabase store;
 * guests (browser-local by design) get the locked-feature 403 contract, and
 * SSO sessions configured to keep queries in their browser get a clear
 * LOCAL_STORAGE_ONLY refusal instead of a misleading role error.
 */
export async function queriesContext(request: Request): Promise<QueriesContext | NextResponse> {
  const limited = rateLimitGuard(request);
  if (limited) return limited;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;

  const env = getServerEnv();
  let store: "local" | "supabase";
  try {
    store = resolveQueriesStore(env, auth.role);
  } catch (error) {
    return jsonError(
      503,
      "SUPABASE_NOT_CONFIGURED",
      error instanceof Error ? error.message : "Saved-query storage is not configured.",
    );
  }

  if (store !== "supabase") {
    if (auth.role === "guest") {
      return NextResponse.json(
        { code: "FORBIDDEN_ROLE", message: "Sign in with an SSO ID to use this", required: "sso" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    return jsonError(
      403,
      "LOCAL_STORAGE_ONLY",
      "Saved queries for your account are stored in this browser — server sync is not configured.",
    );
  }

  return { auth, repo: queriesRepositoryFor(env, auth.sub, auth.limits.savedQueriesMax) };
}

/** Validates that a saved area still exists in the loaded boundary datasets. */
export function assertAreaExists(area: { level: QueryAreaLevel; areaId: string }): void {
  if (area.level === "state") {
    if (area.areaId !== STATE_AREA_ID) {
      throw apiError(400, "INVALID_AREA", `Unknown state area "${area.areaId}".`);
    }
    return;
  }
  if (!resolveArea(area.level, area.areaId)) {
    throw apiError(400, "INVALID_AREA", "The selected area does not exist.");
  }
}

/** Maps repository failures to the { code, message } contract (null = unmapped). */
export function repoErrorResponse(error: unknown): NextResponse | null {
  if (!isQueryRepoError(error)) return null;
  switch (error.code) {
    case "LIMIT_REACHED":
      return jsonError(409, "QUERY_LIMIT_REACHED", error.message);
    case "INVALID_INPUT":
      return jsonError(400, "INVALID_REQUEST", error.message);
    case "UPSTREAM_ERROR":
      return jsonError(503, "STORAGE_UNAVAILABLE", error.message);
    default:
      // NAME_TAKEN → nameTakenResponse() so the caller gets a suggestion.
      return null;
  }
}

/** First free `"Name (n)"` variant (case-insensitive, trailing number stripped). */
export function nextQueryName(taken: string[], attempted: string): string {
  const used = new Set(taken.map((name) => name.toLowerCase()));
  const stem = attempted.replace(/\s\(\d+\)$/, "");
  if (!used.has(stem.toLowerCase())) return stem;
  for (let n = 2; n <= taken.length + 16; n += 1) {
    const candidate = `${stem} (${n})`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem} (${taken.length + 17})`;
}

/** 409 for a duplicate name, offering the next free "Name (n)" spelling. */
export async function nameTakenResponse(
  repo: QueryRepository,
  attempted: string,
): Promise<NextResponse> {
  let suggestion: string | undefined;
  try {
    suggestion = nextQueryName(
      (await repo.list()).map((query) => query.name),
      attempted,
    );
  } catch {
    // Upstream hiccup while computing the suggestion — the 409 still stands.
    suggestion = undefined;
  }
  return NextResponse.json(
    {
      code: "NAME_TAKEN",
      message: `A saved query named "${attempted}" already exists.`,
      ...(suggestion !== undefined ? { suggestion } : {}),
    },
    { status: 409, headers: { "cache-control": "no-store" } },
  );
}
