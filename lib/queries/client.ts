/**
 * Browser half of the saved-queries stack. GET /api/queries/config decides
 * where a session's data lives, then this module builds the matching
 * QueryRepository:
 *
 *   store "local"    → localRepository(subject, { limit }) — this browser,
 *                      same subject key convention as preferences.
 *   store "supabase" → apiQueriesRepository() — CRUD over /api/queries,
 *                      owner always derived server-side from the session.
 *
 * HTTP error bodies ({ code, message, suggestion? }) are re-thrown as
 * QueryRepoError so UI code handles both stores with one error contract.
 */

import {
  QueryRepoError,
  localRepository,
  type QueryRepoErrorCode,
  type QueryRepository,
  type SavedQuery,
  type SavedQueryInput,
  type QueryStore,
} from "./repository";

export interface QueriesConfig {
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

/** Error codes the API can answer with (anything else maps to UPSTREAM_ERROR). */
const REPO_CODES = new Set<QueryRepoErrorCode>([
  "NAME_TAKEN",
  "LIMIT_REACHED",
  "INVALID_INPUT",
  "UPSTREAM_ERROR",
]);

/** Parses an API error body into a QueryRepoError (suggestion kept if offered). */
export async function errorFromResponse(response: Response): Promise<QueryRepoError> {
  let code = "UPSTREAM_ERROR";
  let message = "Saved queries are unavailable. Try again shortly.";
  let suggestion: string | undefined;
  try {
    const body = (await response.json()) as {
      code?: unknown;
      message?: unknown;
      suggestion?: unknown;
    };
    if (typeof body.code === "string") code = body.code;
    if (typeof body.message === "string" && body.message) message = body.message;
    if (typeof body.suggestion === "string") suggestion = body.suggestion;
  } catch {
    // Non-JSON failure (proxy page, offline) — the generic message stands.
  }
  const mapped: QueryRepoErrorCode = REPO_CODES.has(code as QueryRepoErrorCode)
    ? (code as QueryRepoErrorCode)
    : "UPSTREAM_ERROR";
  const error = new QueryRepoError(mapped, message);
  if (suggestion !== undefined) Object.assign(error, { suggestion });
  return error;
}

/** The 409 NAME_TAKEN suggestion ("Name (2)"), when the server offered one. */
export function suggestionOf(error: unknown): string | undefined {
  const value = (error as { suggestion?: unknown } | null)?.suggestion;
  return typeof value === "string" && value ? value : undefined;
}

export async function fetchQueriesConfig(): Promise<QueriesConfig> {
  const response = await fetch("/api/queries/config", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw await errorFromResponse(response);
  return (await response.json()) as QueriesConfig;
}

/**
 * Storage-key subject, mirroring the preferences convention: the SSO
 * username (fallback display name), or "guest". The server never trusts it —
 * for the Supabase store the owner always comes from the session cookie.
 */
export function queriesSubject(
  role: "guest" | "sso" | null,
  username: string | null,
  displayName: string | null,
): string {
  if (role !== "sso") return "guest";
  const trimmed = username?.trim();
  if (trimmed) return trimmed;
  return displayName?.trim() || "sso";
}

/** QueryRepository over the /api/queries routes (server-side Supabase store). */
export function apiQueriesRepository(): QueryRepository {
  const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

  const repo: QueryRepository = {
    store: "supabase",

    async list(): Promise<SavedQuery[]> {
      const response = await call("/api/queries");
      if (!response.ok) throw await errorFromResponse(response);
      const body = (await response.json()) as { queries?: SavedQuery[] };
      return Array.isArray(body.queries) ? body.queries : [];
    },

    async get(id): Promise<SavedQuery | null> {
      const queries = await repo.list();
      return queries.find((query) => query.id === id) ?? null;
    },

    async create(input): Promise<SavedQuery> {
      const response = await call("/api/queries", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!response.ok) throw await errorFromResponse(response);
      const body = (await response.json()) as { query: SavedQuery };
      return body.query;
    },

    async update(id, patch): Promise<SavedQuery | null> {
      const response = await call(`/api/queries/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw await errorFromResponse(response);
      const body = (await response.json()) as { query: SavedQuery };
      return body.query;
    },

    async delete(id): Promise<boolean> {
      const response = await call(`/api/queries/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (response.status === 404) return false;
      if (!response.ok) throw await errorFromResponse(response);
      return true;
    },

    async touchRun(id): Promise<SavedQuery | null> {
      const response = await call(`/api/queries/${encodeURIComponent(id)}/run`, {
        method: "POST",
      });
      if (response.status === 404) return null;
      if (!response.ok) throw await errorFromResponse(response);
      const body = (await response.json()) as { query: SavedQuery };
      return body.query;
    },
  };
  return repo;
}

/** Builds the repository the current session/config allows. */
export function queriesClient(config: QueriesConfig, subject: string): QueryRepository {
  if (config.store === "local") {
    return localRepository(subject, { limit: config.limits.max });
  }
  return apiQueriesRepository();
}

/** Full stored query → create/update payload (metadata and id dropped). */
export function inputFromQuery(query: SavedQuery): SavedQueryInput {
  return {
    name: query.name,
    description: query.description,
    area: query.area,
    dateRange: query.dateRange,
    maxCloud: query.maxCloud,
    composite: query.composite,
    ...(query.compare != null ? { compare: query.compare } : {}),
    pinned: query.pinned,
  };
}
