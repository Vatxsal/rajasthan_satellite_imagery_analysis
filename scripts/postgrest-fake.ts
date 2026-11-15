/**
 * In-memory PostgREST stand-in for the saved_queries table. Used two ways:
 *
 *   - contract tests inject it as fetchImpl into supabaseRepository();
 *   - API tests install it as globalThis.fetch so /api/queries routes run
 *     their real code path (service-role headers, owner filters, PATCH
 *     semantics, unique (owner, lower(name)) → 409/23505).
 *
 * Every request is recorded so tests can assert owner scoping and that the
 * service-role credentials travel on the wire.
 */

export interface FakeCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakePostgrest {
  fetch: typeof fetch;
  calls: FakeCall[];
  rows(): Record<string, unknown>[];
  reset(): void;
}

type StoredRow = Record<string, unknown>;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBody(init?: RequestInit): StoredRow {
  try {
    return JSON.parse(String(init?.body ?? "{}")) as StoredRow;
  } catch {
    return {};
  }
}

function collectHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = init?.headers;
  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
  } else if (raw) {
    for (const [key, value] of Object.entries(raw as Record<string, string | undefined>)) {
      if (value !== undefined) headers[key.toLowerCase()] = String(value);
    }
  }
  return headers;
}

const UNIQUE_MESSAGE = 'duplicate key value violates unique constraint "saved_queries_owner_name_key"';

export function createFakePostgrest(
  options: { url?: string; serviceRoleKey?: string } = {},
): FakePostgrest {
  const table = `${(options.url ?? "http://supabase.test").replace(/\/+$/, "")}/rest/v1/saved_queries`;
  const rows = new Map<string, StoredRow>();
  const calls: FakeCall[] = [];

  function matches(row: StoredRow, params: URLSearchParams): boolean {
    for (const [key, raw] of params) {
      if (!raw.startsWith("eq.")) continue;
      if (String(row[key] ?? "") !== raw.slice(3)) return false;
    }
    return true;
  }

  function nameTaken(candidate: StoredRow, ignoreId?: string): boolean {
    const owner = String(candidate.owner ?? "");
    const name = String(candidate.name ?? "").toLowerCase();
    for (const row of rows.values()) {
      if (String(row.id) === ignoreId) continue;
      if (String(row.owner) === owner && String(row.name).toLowerCase() === name) return true;
    }
    return false;
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = collectHeaders(init);
    calls.push({ method, url, headers, body: init?.body ? parseBody(init) : null });

    if (!url.startsWith(table)) {
      return json({ message: `unexpected URL ${url}` }, 404);
    }

    const parsed = new URL(url);
    const matched = [...rows.values()].filter((row) => matches(row, parsed.searchParams));

    if (method === "GET") {
      let result = matched;
      if (parsed.searchParams.get("order") === "updated_at.desc") {
        result = [...result].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      }
      const limit = Number(parsed.searchParams.get("limit") ?? "NaN");
      if (Number.isFinite(limit) && limit > 0) result = result.slice(0, limit);
      return json(
        result.map((row) => ({ ...row })),
        200,
      );
    }

    if (method === "POST") {
      const body = parseBody(init);
      if (nameTaken(body)) return json({ code: "23505", message: UNIQUE_MESSAGE }, 409);
      rows.set(String(body.id), body);
      return json([{ ...body }], 201);
    }

    if (method === "PATCH") {
      const body = parseBody(init);
      const updated: StoredRow[] = [];
      for (const row of matched) {
        if ("name" in body && nameTaken({ ...row, ...body }, String(row.id))) {
          return json({ code: "23505", message: UNIQUE_MESSAGE }, 409);
        }
        Object.assign(row, body);
        updated.push({ ...row });
      }
      return json(updated, 200);
    }

    if (method === "DELETE") {
      const removed: StoredRow[] = [];
      for (const row of matched) {
        rows.delete(String(row.id));
        removed.push({ ...row });
      }
      return json(removed, 200);
    }

    return json({ message: "method not allowed" }, 405);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    calls,
    rows: () => [...rows.values()].map((row) => ({ ...row })),
    reset: () => {
      rows.clear();
      calls.length = 0;
    },
  };
}
