import { z } from "zod";

/**
 * Saved queries — a user's named filter presets (area, date window, cloud
 * ceiling, composite, optional compare settings) plus lightweight run stats.
 *
 * Two interchangeable adapters implement QueryRepository:
 *
 *   localRepository(subject)   this browser only — key
 *                              `rie:queries:v1:<subject>`, zod-validated per
 *                              entry with an in-memory fallback when
 *                              localStorage is unavailable (privacy modes,
 *                              node tests). Guests and Supabase-less SSO.
 *   supabaseRepository(conn,…) PostgREST over fetch — SERVER ONLY; the
 *                              service-role key is injected by lib/server and
 *                              never reaches the browser (client code calls
 *                              GET/POST /api/queries instead).
 *
 * Both enforce the same contract: case-insensitive unique names per owner
 * (NAME_TAKEN), an optional role cap (LIMIT_REACHED), strict input schemas
 * (INVALID_INPUT) and `null`/`false` returns instead of throws for
 * not-found rows. GET /api/queries/config is the single place that decides
 * which store a session uses.
 */

/** Where a session's saved queries persist. */
export type QueryStore = "local" | "supabase";

export const QUERY_AREA_LEVELS = ["district", "tehsil", "ilr", "state"] as const;
export type QueryAreaLevel = (typeof QUERY_AREA_LEVELS)[number];

export const QUERIES_STORAGE_PREFIX = "rie:queries:v1:";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** C0 controls + DEL — names must stay single-line and printable. */
const LINE_CONTROL_RE = /[\u0000-\u001F\u007F]/g;
/** Same, minus tab/newline/CR — descriptions may wrap. */
const BLOCK_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function cleanLine(value: string): string {
  return value.replace(LINE_CONTROL_RE, "").trim();
}

function cleanBlock(value: string): string {
  return value.replace(BLOCK_CONTROL_RE, "").trim();
}

/** Cleans FIRST, then length-checks the visible text (raw padding can't sneak past). */
const lineText = (min: number, max: number) =>
  z
    .string()
    .transform(cleanLine)
    .pipe(z.string().min(min, `must be at least ${min} character(s)`).max(max));

const blockText = (max: number) => z.string().transform(cleanBlock).pipe(z.string().max(max));

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a valid timestamp");

export const queryAreaSchema = z
  .object({
    level: z.enum(QUERY_AREA_LEVELS),
    areaId: z.string().trim().min(1).max(128),
    name: lineText(1, 120),
  })
  .strict();

/**
 * Relative ranges (recalculated from today when the query runs) or absolute
 * YYYY-MM-DD bounds. Inapplicable keys are stripped on parse so stored rows
 * stay minimal and identical across both adapters.
 */
export const queryDateRangeSchema = z
  .object({
    mode: z.enum(["relative", "absolute"]),
    days: z.number().int().min(1).max(1096).optional(),
    from: z.string().regex(DATE_RE, "from must be YYYY-MM-DD").optional(),
    to: z.string().regex(DATE_RE, "to must be YYYY-MM-DD").optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "relative") {
      if (value.days === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["days"],
          message: "relative ranges need days",
        });
      }
      return;
    }
    if (value.from === undefined || value.to === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["from"],
        message: "absolute ranges need from and to",
      });
      return;
    }
    if (Date.parse(value.from) > Date.parse(value.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["to"],
        message: "to must be on or after from",
      });
    }
  })
  .transform((value) =>
    value.mode === "relative"
      ? { mode: "relative" as const, days: value.days }
      : { mode: "absolute" as const, from: value.from as string, to: value.to as string },
  );

export const queryCompareSchema = z
  .object({
    sensitivity: z.enum(["low", "medium", "high"]),
    minPatchHa: z.number().min(0.01).max(100),
  })
  .strict();

/** Fully stored query (what list/get/create/update return). */
export const savedQuerySchema = z.object({
  id: z.string().min(1).max(64),
  name: lineText(1, 80),
  description: blockText(200),
  area: queryAreaSchema,
  dateRange: queryDateRangeSchema,
  maxCloud: z.number().int().min(0).max(100),
  composite: z.enum(["true-color", "false-color", "ndvi"]),
  compare: queryCompareSchema.nullish(),
  pinned: z.boolean().default(false),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastRunAt: timestamp.nullable(),
  runCount: z.number().int().min(0).default(0),
});

/** Create/update payload — strict: unknown keys are rejected (typos, old exports). */
const savedQueryInputBase = z
  .object({
    name: lineText(1, 80),
    description: blockText(200).default(""),
    area: queryAreaSchema,
    dateRange: queryDateRangeSchema,
    maxCloud: z.number().int().min(0).max(100),
    composite: z.enum(["true-color", "false-color", "ndvi"]),
    compare: queryCompareSchema.nullish(),
    pinned: z.boolean().default(false),
  })
  .strict();

export const savedQueryInputSchema = savedQueryInputBase;
export const savedQueryPatchSchema = savedQueryInputBase.partial();

/** Caller-facing input (defaults may be omitted). */
export type SavedQueryInput = z.input<typeof savedQueryInputBase>;
/** Parsed input (defaults applied) — what adapters persist. */
export type SavedQueryDraft = z.output<typeof savedQueryInputBase>;
/** Patch body: any subset of the input fields. */
export type SavedQueryPatch = Partial<SavedQueryInput>;
export type SavedQuery = z.infer<typeof savedQuerySchema>;

export type QueryRepoErrorCode =
  /** Unique-name conflict (case-insensitive) for this owner. */
  | "NAME_TAKEN"
  /** The role's saved-query cap is already full. */
  | "LIMIT_REACHED"
  /** Schema validation failed (see message for the first issue). */
  | "INVALID_INPUT"
  /** Supabase/network failure — retryable, never leaks upstream detail. */
  | "UPSTREAM_ERROR";

export class QueryRepoError extends Error {
  readonly code: QueryRepoErrorCode;

  constructor(code: QueryRepoErrorCode, message: string) {
    super(message);
    this.name = "QueryRepoError";
    this.code = code;
  }
}

/**
 * Storage contract shared by the API routes, the UI and the contract tests.
 * Not-found rows resolve to null/false — only validation, uniqueness, limit
 * and upstream problems throw QueryRepoError.
 */
export interface QueryRepository {
  readonly store: QueryStore;
  list(): Promise<SavedQuery[]>;
  get(id: string): Promise<SavedQuery | null>;
  create(input: SavedQueryInput): Promise<SavedQuery>;
  update(id: string, patch: SavedQueryPatch): Promise<SavedQuery | null>;
  delete(id: string): Promise<boolean>;
  touchRun(id: string): Promise<SavedQuery | null>;
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "query"}: ${issue.message}`)
    .join("; ");
}

function parseInput(input: unknown): SavedQueryDraft {
  const parsed = savedQueryInputSchema.safeParse(input);
  if (!parsed.success) throw new QueryRepoError("INVALID_INPUT", issueSummary(parsed.error));
  return parsed.data;
}

/** v4-shaped id; Math.random fallback for non-secure http:// LAN contexts. */
function newQueryId(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (webCrypto && typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

/** Case-insensitive unique-name rule (matches lower(name) in Postgres). */
function assertNameFree(entries: SavedQuery[], name: string, ignoreId?: string): void {
  const wanted = name.toLowerCase();
  if (entries.some((entry) => entry.id !== ignoreId && entry.name.toLowerCase() === wanted)) {
    throw new QueryRepoError("NAME_TAKEN", `A saved query named "${name}" already exists.`);
  }
}

function assertCapacity(count: number, limit: number | undefined): void {
  if (limit !== undefined && count >= limit) {
    throw new QueryRepoError("LIMIT_REACHED", `You can save up to ${limit} queries.`);
  }
}

// ── Browser adapter ──────────────────────────────────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LocalRepositoryOptions {
  /** Role cap — create() throws LIMIT_REACHED once the list is full. */
  limit?: number;
  /** Injectable storage for tests: omit = probe window.localStorage, null = force memory. */
  storage?: StorageLike | null;
}

/**
 * In-memory mirror of every storage key written this session: hosts node/test
 * sessions outright and keeps data alive when a localStorage write fails
 * (quota/private mode) mid-session.
 */
const memoryStore = new Map<string, string>();

/** Storage probe that tolerates privacy modes (access can throw). */
function probeLocalStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    const probe = `${QUERIES_STORAGE_PREFIX}__probe__`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Per-entry validation: one corrupt row never wipes the rest (safe fallback). */
function parseEntries(text: string | null): SavedQuery[] {
  if (text === null) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const entries: SavedQuery[] = [];
  for (const item of raw) {
    const parsed = savedQuerySchema.safeParse(item);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

export function localRepository(
  subject: string,
  options: LocalRepositoryOptions = {},
): QueryRepository {
  const key = QUERIES_STORAGE_PREFIX + subject;
  const storage = options.storage === undefined ? probeLocalStorage() : options.storage;

  function readText(): string | null {
    if (storage) {
      try {
        const text = storage.getItem(key);
        if (text !== null) return text;
      } catch {
        // Unreadable storage — fall through to the session mirror.
      }
    }
    return memoryStore.get(key) ?? null;
  }

  function write(entries: SavedQuery[]): void {
    const text = JSON.stringify(entries);
    memoryStore.set(key, text);
    if (storage) {
      try {
        storage.setItem(key, text);
      } catch {
        // Quota/full: the mirror keeps this session working.
      }
    }
  }

  function load(): SavedQuery[] {
    return parseEntries(readText());
  }

  function save(entries: SavedQuery[]): void {
    write(entries);
  }

  async function list(): Promise<SavedQuery[]> {
    return load();
  }

  async function get(id: string): Promise<SavedQuery | null> {
    return load().find((entry) => entry.id === id) ?? null;
  }

  async function create(input: SavedQueryInput): Promise<SavedQuery> {
    const draft = parseInput(input);
    const entries = load();
    assertNameFree(entries, draft.name);
    assertCapacity(entries.length, options.limit);
    const now = new Date().toISOString();
    const query: SavedQuery = {
      ...draft,
      id: newQueryId(),
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      runCount: 0,
    };
    save([...entries, query]);
    return query;
  }

  async function update(id: string, patch: SavedQueryPatch): Promise<SavedQuery | null> {
    const parsedPatch = savedQueryPatchSchema.safeParse(patch);
    if (!parsedPatch.success) {
      throw new QueryRepoError("INVALID_INPUT", issueSummary(parsedPatch.error));
    }
    const entries = load();
    const existing = entries.find((entry) => entry.id === id);
    if (!existing) return null;
    // Drop explicit-undefined keys so a partial patch never clobbers with undefined.
    const cleanPatch = Object.fromEntries(
      Object.entries(parsedPatch.data).filter(([, value]) => value !== undefined),
    );
    if ("name" in cleanPatch) {
      assertNameFree(entries, String(cleanPatch.name), id);
    }
    const merged = savedQuerySchema.safeParse({
      ...existing,
      ...cleanPatch,
      updatedAt: new Date().toISOString(),
    });
    if (!merged.success) {
      throw new QueryRepoError("INVALID_INPUT", issueSummary(merged.error));
    }
    save(entries.map((entry) => (entry.id === id ? merged.data : entry)));
    return merged.data;
  }

  async function remove(id: string): Promise<boolean> {
    const entries = load();
    const next = entries.filter((entry) => entry.id !== id);
    if (next.length === entries.length) return false;
    save(next);
    return true;
  }

  async function touchRun(id: string): Promise<SavedQuery | null> {
    const entries = load();
    const existing = entries.find((entry) => entry.id === id);
    if (!existing) return null;
    const updated: SavedQuery = {
      ...existing,
      lastRunAt: new Date().toISOString(),
      runCount: existing.runCount + 1,
    };
    save(entries.map((entry) => (entry.id === id ? updated : entry)));
    return updated;
  }

  return { store: "local", list, get, create, update, delete: remove, touchRun };
}

// ── Supabase adapter (server only) ───────────────────────────────────────────

export interface SupabaseConnection {
  /** Project URL, e.g. https://abcdxyz.supabase.co */
  url: string;
  /** Server-side service-role/secret key — NEVER expose to browsers. */
  serviceRoleKey: string;
}

export interface SupabaseRepositoryOptions {
  /** Role cap checked before insert — LIMIT_REACHED past it. */
  limit?: number;
  /** Injectable fetch for contract tests (defaults to global fetch). */
  fetchImpl?: typeof fetch;
}

const SAVED_QUERIES_TABLE = "saved_queries";
/** Read cap — far above role limits (5/50) but bounded for huge lists. */
const LIST_CAP = 200;

/** snake_case row as PostgREST returns it. */
interface SavedQueryRow {
  id: string;
  owner: string;
  name: string;
  description: string | null;
  area: unknown;
  date_range: unknown;
  max_cloud: number;
  composite: string;
  compare: unknown;
  pinned: boolean;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  run_count: number;
}

/** Row → SavedQuery; null when a hand-edited row fails validation (skipped, not fatal). */
function rowToQuery(row: SavedQueryRow): SavedQuery | null {
  const parsed = savedQuerySchema.safeParse({
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    area: row.area,
    dateRange: row.date_range,
    maxCloud: row.max_cloud,
    composite: row.composite,
    compare: row.compare ?? null,
    pinned: row.pinned,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    runCount: row.run_count,
  });
  return parsed.success ? parsed.data : null;
}

/** Maps PostgREST failures to the typed contract (23505/409 = unique name). */
function mapSupabaseFailure(status: number, body: unknown): QueryRepoError {
  const details = (body && typeof body === "object" ? body : {}) as { code?: string };
  if (status === 409 || details.code === "23505") {
    return new QueryRepoError("NAME_TAKEN", "A saved query with this name already exists.");
  }
  if (status === 401 || status === 403) {
    return new QueryRepoError(
      "UPSTREAM_ERROR",
      "Saved-query storage rejected the server credentials.",
    );
  }
  return new QueryRepoError(
    "UPSTREAM_ERROR",
    "Saved-query storage is unavailable. Try again shortly.",
  );
}

/**
 * PostgREST adapter scoped to one owner. Every statement carries
 * owner=eq.<sub> so rows of other users are unreachable even though the
 * service-role key bypasses RLS (RLS exists for defense-in-depth only).
 */
export function supabaseRepository(
  connection: SupabaseConnection,
  owner: string,
  options: SupabaseRepositoryOptions = {},
): QueryRepository {
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch;
  const base = `${connection.url.replace(/\/+$/, "")}/rest/v1/${SAVED_QUERIES_TABLE}`;
  const scope = `owner=${encodeURIComponent(owner)}`;
  const headers: Record<string, string> = {
    apikey: connection.serviceRoleKey,
    Authorization: `Bearer ${connection.serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };

  async function rest(path: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: { ...headers, ...(init?.headers ?? {}) },
      });
    } catch {
      throw new QueryRepoError(
        "UPSTREAM_ERROR",
        "Saved-query storage is unreachable. Try again shortly.",
      );
    }
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!response.ok) throw mapSupabaseFailure(response.status, body);
    return body;
  }

  async function rows(path: string, init?: RequestInit): Promise<SavedQueryRow[]> {
    const body = await rest(path, init);
    if (!Array.isArray(body)) {
      throw new QueryRepoError(
        "UPSTREAM_ERROR",
        "Saved-query storage returned an unexpected response.",
      );
    }
    return body as SavedQueryRow[];
  }

  function mapRows(data: SavedQueryRow[]): SavedQuery[] {
    const queries: SavedQuery[] = [];
    for (const row of data) {
      const query = rowToQuery(row);
      if (query) queries.push(query);
    }
    return queries;
  }

  function first(data: SavedQueryRow[]): SavedQuery | null {
    const query = data[0] ? rowToQuery(data[0]) : null;
    if (data.length > 0 && !query) {
      throw new QueryRepoError(
        "UPSTREAM_ERROR",
        "Saved-query storage returned an unexpected response.",
      );
    }
    return query;
  }

  async function list(): Promise<SavedQuery[]> {
    const data = await rows(`?${scope}&select=*&order=updated_at.desc&limit=${LIST_CAP}`);
    return mapRows(data);
  }

  async function get(id: string): Promise<SavedQuery | null> {
    const data = await rows(`?${scope}&id=eq.${encodeURIComponent(id)}&select=*`);
    return first(data);
  }

  async function create(input: SavedQueryInput): Promise<SavedQuery> {
    const draft = parseInput(input);
    assertCapacity((await list()).length, options.limit);
    const now = new Date().toISOString();
    const row: SavedQueryRow = {
      id: newQueryId(),
      owner,
      name: draft.name,
      description: draft.description || null,
      area: draft.area,
      date_range: draft.dateRange,
      max_cloud: draft.maxCloud,
      composite: draft.composite,
      compare: draft.compare ?? null,
      pinned: draft.pinned,
      created_at: now,
      updated_at: now,
      last_run_at: null,
      run_count: 0,
    };
    const data = await rows("", { method: "POST", body: JSON.stringify(row) });
    const query = first(data);
    if (!query) {
      throw new QueryRepoError(
        "UPSTREAM_ERROR",
        "Saved-query storage returned an unexpected response.",
      );
    }
    return query;
  }

  const COLUMN_BY_FIELD: Record<string, string> = {
    name: "name",
    description: "description",
    area: "area",
    dateRange: "date_range",
    maxCloud: "max_cloud",
    composite: "composite",
    compare: "compare",
    pinned: "pinned",
  };

  async function update(id: string, patch: SavedQueryPatch): Promise<SavedQuery | null> {
    const parsedPatch = savedQueryPatchSchema.safeParse(patch);
    if (!parsedPatch.success) {
      throw new QueryRepoError("INVALID_INPUT", issueSummary(parsedPatch.error));
    }
    const existing = await get(id);
    if (!existing) return null;
    const cleanPatch = Object.fromEntries(
      Object.entries(parsedPatch.data).filter(([, value]) => value !== undefined),
    );
    const merged = savedQuerySchema.safeParse({
      ...existing,
      ...cleanPatch,
      updatedAt: new Date().toISOString(),
    });
    if (!merged.success) {
      throw new QueryRepoError("INVALID_INPUT", issueSummary(merged.error));
    }
    const body: Record<string, unknown> = { updated_at: merged.data.updatedAt };
    for (const [field, value] of Object.entries(cleanPatch)) {
      const column = COLUMN_BY_FIELD[field];
      if (!column) continue;
      body[column] = column === "description" || column === "compare" ? (value ?? null) : value;
    }
    // Unspecified columns keep their value (PostgREST PATCH semantics);
    // duplicate names surface as 23505 → NAME_TAKEN via mapSupabaseFailure().
    const data = await rows(`?${scope}&id=eq.${encodeURIComponent(id)}&select=*`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return first(data);
  }

  async function remove(id: string): Promise<boolean> {
    const data = await rows(`?${scope}&id=eq.${encodeURIComponent(id)}&select=id`, {
      method: "DELETE",
    });
    return data.length > 0;
  }

  async function touchRun(id: string): Promise<SavedQuery | null> {
    const existing = await get(id);
    if (!existing) return null;
    const data = await rows(`?${scope}&id=eq.${encodeURIComponent(id)}&select=*`, {
      method: "PATCH",
      body: JSON.stringify({
        last_run_at: new Date().toISOString(),
        run_count: existing.runCount + 1,
      }),
    });
    return first(data);
  }

  return { store: "supabase", list, get, create, update, delete: remove, touchRun };
}
