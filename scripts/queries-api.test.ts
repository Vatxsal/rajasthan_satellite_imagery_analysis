import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { GET as configGet } from "../app/api/queries/config/route";
import { GET as listGet, POST as createPost } from "../app/api/queries/route";
import { DELETE as deleteItem, PATCH as patchItem } from "../app/api/queries/[id]/route";
import { POST as runItem } from "../app/api/queries/[id]/run/route";
import { guestCookie, ssoCookie, useReadyAuthGate } from "./test-session";
import { createFakePostgrest, type FakePostgrest } from "./postgrest-fake";

/** /api/queries contract with RAW requests: session + store gates, strict
 *  validation, unique-name suggestions, per-role caps, owner isolation and
 *  the run counter — all against the in-memory PostgREST fake. */

const REAL_FETCH = globalThis.fetch;

interface EnvHolder {
  "rse.serverEnv"?: { cached: unknown };
  "rse.rateBuckets"?: Record<string, Map<string, unknown>>;
}

const QUERIES_URL = "http://localhost/api/queries";
const CONFIG_URL = "http://localhost/api/queries/config";

const CREATE_BODY = {
  name: "Kharif watch",
  description: "Kharif monitoring preset",
  area: { level: "district", areaId: "d-jaisalmer", name: "Jaisalmer" },
  dateRange: { mode: "relative", days: 120 },
  maxCloud: 25,
  composite: "false-color",
};

function nullEnvCache(): void {
  const holder = globalThis as unknown as EnvHolder;
  if (holder["rse.serverEnv"]) holder["rse.serverEnv"].cached = null;
}

let fake: FakePostgrest;

function resetState(): void {
  process.env.RATE_LIMIT_PER_MIN = "10000";
  process.env.SAVED_QUERIES_STORE = "supabase";
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  useReadyAuthGate();

  nullEnvCache();
  const buckets = (globalThis as unknown as EnvHolder)["rse.rateBuckets"];
  if (buckets) for (const map of Object.values(buckets)) map.clear();

  fake = createFakePostgrest({ url: "http://supabase.test" });
  globalThis.fetch = fake.fetch;
}

beforeEach(resetState);
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- route handlers carry their own context shapes
type Handler = (request: Request, context?: any) => Promise<Response>;

async function call(
  handler: Handler,
  request: Request,
  context?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null; headers: Headers }> {
  const response = await handler(request, context);
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

interface RequestOptions {
  cookie?: string;
  origin?: string;
}

function send(
  method: string,
  url: string,
  payload?: unknown,
  options: RequestOptions = {},
): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
}

function get(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}

type Result = { status: number; body: Record<string, unknown> | null; headers: Headers };

function assertUnauthenticated(result: Result): void {
  assert.equal(result.status, 401, JSON.stringify(result.body));
  assert.equal(result.body?.code, "UNAUTHENTICATED");
}

function itemUrl(id: string): string {
  return `${QUERIES_URL}/${id}`;
}

// ---------------------------------------------------------------- config

test("config: 401 without a session", async () => {
  assertUnauthenticated(await call(configGet, get(CONFIG_URL)));
});

test("config: SSO with Supabase configured → store supabase and role caps", async () => {
  const result = await call(configGet, get(CONFIG_URL, await ssoCookie("alice")));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, {
    store: "supabase",
    limits: { role: "sso", max: 50, guest: 5, sso: 50 },
  });
  assert.equal(result.headers.get("cache-control"), "no-store");
});

test("config: guests always resolve to browser-local storage", async () => {
  const result = await call(configGet, get(CONFIG_URL, await guestCookie()));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, {
    store: "local",
    limits: { role: "guest", max: 5, guest: 5, sso: 50 },
  });
});

test("config: SAVED_QUERIES_STORE=local pins SSO to this browser", async () => {
  process.env.SAVED_QUERIES_STORE = "local";
  nullEnvCache();
  const result = await call(configGet, get(CONFIG_URL, await ssoCookie("alice")));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((result.body as { store?: string }).store, "local");
});

test("config: explicit supabase without credentials → 503 SUPABASE_NOT_CONFIGURED", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  nullEnvCache();
  const result = await call(configGet, get(CONFIG_URL, await ssoCookie("alice")));
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body?.code, "SUPABASE_NOT_CONFIGURED");
  assert.ok(!JSON.stringify(result.body).includes("service-role-test-key"), "no secrets leaked");
});

// ---------------------------------------------------------------- list + create

test("list: 401 without a session, then empty for a fresh SSO user", async () => {
  assertUnauthenticated(await call(listGet, get(QUERIES_URL)));
  const result = await call(listGet, get(QUERIES_URL, await ssoCookie("alice")));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body, { queries: [] });
});

test("create: 201 with cleaned name, then visible in the list (same-origin accepted)", async () => {
  const cookie = await ssoCookie("alice");
  const result = await call(
    createPost,
    send("POST", QUERIES_URL, { ...CREATE_BODY, name: "  Kharif\u0000 watch  " }, {
      cookie,
      origin: "http://localhost",
    }),
  );
  assert.equal(result.status, 201, JSON.stringify(result.body));
  const query = result.body?.query as Record<string, unknown>;
  assert.equal(query.name, "Kharif watch");
  assert.equal(query.runCount, 0);
  assert.equal(query.lastRunAt, null);
  assert.equal(query.pinned, false);

  const listed = await call(listGet, get(QUERIES_URL, cookie));
  const queries = (listed.body as { queries: unknown[] }).queries;
  assert.equal(queries.length, 1);
});

test("create: cross-origin requests are refused", async () => {
  const result = await call(
    createPost,
    send("POST", QUERIES_URL, CREATE_BODY, {
      cookie: await ssoCookie("alice"),
      origin: "https://evil.test",
    }),
  );
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body?.code, "CROSS_ORIGIN");
});

test("create: guests are refused server-side with the locked-feature contract", async () => {
  const result = await call(
    createPost,
    send("POST", QUERIES_URL, { ...CREATE_BODY, compare: { sensitivity: "high", minPatchHa: 1 } }, {
      cookie: await guestCookie(),
    }),
  );
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body?.code, "FORBIDDEN_ROLE");
  assert.equal(result.body?.message, "Sign in with an SSO ID to use this");
  assert.equal(result.body?.required, "sso");
});

test("create: SSO with a browser-local store gets LOCAL_STORAGE_ONLY", async () => {
  process.env.SAVED_QUERIES_STORE = "local";
  nullEnvCache();
  const result = await call(
    createPost,
    send("POST", QUERIES_URL, CREATE_BODY, { cookie: await ssoCookie("alice") }),
  );
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body?.code, "LOCAL_STORAGE_ONLY");
});

test("create: unknown and mis-fit areas are rejected", async () => {
  const cookie = await ssoCookie("alice");
  const unknown = await call(
    createPost,
    send("POST", QUERIES_URL, {
      ...CREATE_BODY,
      area: { level: "district", areaId: "d-does-not-exist", name: "Nowhere" },
    }, { cookie }),
  );
  assert.equal(unknown.status, 400, JSON.stringify(unknown.body));
  assert.equal(unknown.body?.code, "INVALID_AREA");

  const badState = await call(
    createPost,
    send("POST", QUERIES_URL, {
      ...CREATE_BODY,
      name: "Whole state",
      area: { level: "state", areaId: "karnataka", name: "Karnataka" },
    }, { cookie }),
  );
  assert.equal(badState.status, 400, JSON.stringify(badState.body));
  assert.equal(badState.body?.code, "INVALID_AREA");

  const goodState = await call(
    createPost,
    send("POST", QUERIES_URL, {
      ...CREATE_BODY,
      name: "Whole state",
      area: { level: "state", areaId: "rj", name: "Rajasthan" },
    }, { cookie }),
  );
  assert.equal(goodState.status, 201, JSON.stringify(goodState.body));
});

test("create: schema failures answer 400 with a helpful detail", async () => {
  const cookie = await ssoCookie("alice");
  const cloudy = await call(
    createPost,
    send("POST", QUERIES_URL, { ...CREATE_BODY, maxCloud: 150 }, { cookie }),
  );
  assert.equal(cloudy.status, 400, JSON.stringify(cloudy.body));
  assert.equal(cloudy.body?.code, "INVALID_REQUEST");
  assert.match(String(cloudy.body?.message), /maxCloud/);

  const typo = await call(
    createPost,
    send("POST", QUERIES_URL, { ...CREATE_BODY, bogus: true }, { cookie }),
  );
  assert.equal(typo.status, 400, JSON.stringify(typo.body));
  assert.match(String(typo.body?.message), /bogus/);
});

test("create: duplicate names answer 409 with a free suggestion", async () => {
  const cookie = await ssoCookie("alice");
  const first = await call(createPost, send("POST", QUERIES_URL, CREATE_BODY, { cookie }));
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const clash = await call(createPost, send("POST", QUERIES_URL, CREATE_BODY, { cookie }));
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.equal(clash.body?.code, "NAME_TAKEN");
  assert.equal(clash.body?.suggestion, "Kharif watch (2)");

  const caseClash = await call(
    createPost,
    send("POST", QUERIES_URL, { ...CREATE_BODY, name: "kharif watch" }, { cookie }),
  );
  assert.equal(caseClash.status, 409, JSON.stringify(caseClash.body));
  assert.equal(caseClash.body?.suggestion, "kharif watch (2)");
});

test("create: the 50-query SSO cap answers 409 QUERY_LIMIT_REACHED", async () => {
  const cookie = await ssoCookie("alice");
  for (let i = 1; i <= 50; i += 1) {
    const result = await call(
      createPost,
      send("POST", QUERIES_URL, { ...CREATE_BODY, name: `Preset ${i}` }, { cookie }),
    );
    assert.equal(result.status, 201, `#${i}: ${JSON.stringify(result.body)}`);
  }
  const overflow = await call(
    createPost,
    send("POST", QUERIES_URL, { ...CREATE_BODY, name: "Preset 51" }, { cookie }),
  );
  assert.equal(overflow.status, 409, JSON.stringify(overflow.body));
  assert.equal(overflow.body?.code, "QUERY_LIMIT_REACHED");
  assert.match(String(overflow.body?.message), /50/);

  const listed = await call(listGet, get(QUERIES_URL, cookie));
  assert.equal(((listed.body as { queries: unknown[] }).queries).length, 50);
});

// ---------------------------------------------------------------- owner isolation

test("isolation: another SSO user cannot read, patch, run or delete the query (incl. guessed ids)", async () => {
  const alice = await ssoCookie("alice");
  const created = await call(createPost, send("POST", QUERIES_URL, CREATE_BODY, { cookie: alice }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = (created.body?.query as { id: string }).id;

  const bob = await ssoCookie("bob");
  const listed = await call(listGet, get(QUERIES_URL, bob));
  assert.deepEqual((listed.body as { queries: unknown[] }).queries, []);

  const patched = await call(patchItem, send("PATCH", itemUrl(id), { name: "Stolen" }, { cookie: bob }), {
    params: { id },
  });
  assert.equal(patched.status, 404, JSON.stringify(patched.body));
  assert.equal(patched.body?.code, "NOT_FOUND");

  const removed = await call(deleteItem, send("DELETE", itemUrl(id), undefined, { cookie: bob }), {
    params: { id },
  });
  assert.equal(removed.status, 404, JSON.stringify(removed.body));

  const run = await call(runItem, send("POST", itemUrl(id), undefined, { cookie: bob }), {
    params: { id },
  });
  assert.equal(run.status, 404, JSON.stringify(run.body));

  const guessed = "11111111-2222-4333-8444-555555555555";
  const probe = await call(patchItem, send("PATCH", itemUrl(guessed), { name: "Probed" }, { cookie: bob }), {
    params: { id: guessed },
  });
  assert.equal(probe.status, 404, JSON.stringify(probe.body));

  const aliceAfter = await call(listGet, get(QUERIES_URL, alice));
  const queries = (aliceAfter.body as { queries: Array<{ id: string; name: string }> }).queries;
  assert.equal(queries.length, 1, "the victim's data survives every attempt");
  assert.equal(queries[0].name, CREATE_BODY.name);
});

// ---------------------------------------------------------------- patch + run + delete

test("patch: applies updates, rejects unknown keys and conflicting renames", async () => {
  const cookie = await ssoCookie("alice");
  const created = await call(createPost, send("POST", QUERIES_URL, CREATE_BODY, { cookie }));
  const other = await call(
    createPost,
    send("POST", QUERIES_URL, { ...CREATE_BODY, name: "Drought monitor" }, { cookie }),
  );
  const id = (created.body?.query as { id: string }).id;
  const otherId = (other.body?.query as { id: string }).id;

  const patched = await call(
    patchItem,
    send("PATCH", itemUrl(id), { name: "Renamed preset", pinned: true, maxCloud: 10 }, { cookie }),
    { params: { id } },
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const query = patched.body?.query as Record<string, unknown>;
  assert.equal(query.name, "Renamed preset");
  assert.equal(query.pinned, true);
  assert.equal(query.maxCloud, 10);
  assert.equal(query.description, CREATE_BODY.description, "untouched fields survive");

  const typo = await call(patchItem, send("PATCH", itemUrl(id), { nope: 1 }, { cookie }), {
    params: { id },
  });
  assert.equal(typo.status, 400, JSON.stringify(typo.body));

  const clash = await call(
    patchItem,
    send("PATCH", itemUrl(id), { name: "drought monitor" }, { cookie }),
    { params: { id } },
  );
  assert.equal(clash.status, 409, JSON.stringify(clash.body));
  assert.equal(clash.body?.code, "NAME_TAKEN");
  assert.equal(clash.body?.suggestion, "drought monitor (2)");

  const badId = await call(patchItem, send("PATCH", itemUrl("not a uuid!"), { name: "X" }, { cookie }), {
    params: { id: "not a uuid!" },
  });
  assert.equal(badId.status, 404, JSON.stringify(badId.body));

  const untouched = await call(listGet, get(QUERIES_URL, cookie));
  const names = (untouched.body as { queries: Array<{ name: string }> }).queries.map((q) => q.name);
  assert.ok(names.includes("Renamed preset"));
  assert.equal(names.length, 2, `${otherId} kept its own name`);
});

test("run: counts runs for the owner and 404s unknown ids", async () => {
  const cookie = await ssoCookie("alice");
  const created = await call(createPost, send("POST", QUERIES_URL, CREATE_BODY, { cookie }));
  const id = (created.body?.query as { id: string }).id;

  const first = await call(runItem, send("POST", itemUrl(id), undefined, { cookie }), {
    params: { id },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const query = first.body?.query as Record<string, unknown>;
  assert.equal(query.runCount, 1);
  assert.ok(query.lastRunAt);

  const second = await call(runItem, send("POST", itemUrl(id), undefined, { cookie }), {
    params: { id },
  });
  assert.equal((second.body?.query as { runCount: number }).runCount, 2);

  const ghost = "99999999-8888-4777-8666-555555555555";
  const missing = await call(runItem, send("POST", itemUrl(ghost), undefined, { cookie }), {
    params: { id: ghost },
  });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  assert.equal(missing.body?.code, "NOT_FOUND");
});

test("delete: removes once, then 404; list reflects the removal", async () => {
  const cookie = await ssoCookie("alice");
  const created = await call(createPost, send("POST", QUERIES_URL, CREATE_BODY, { cookie }));
  const id = (created.body?.query as { id: string }).id;

  const first = await call(deleteItem, send("DELETE", itemUrl(id), undefined, { cookie }), {
    params: { id },
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { deleted: true });

  const second = await call(deleteItem, send("DELETE", itemUrl(id), undefined, { cookie }), {
    params: { id },
  });
  assert.equal(second.status, 404, JSON.stringify(second.body));

  const listed = await call(listGet, get(QUERIES_URL, cookie));
  assert.deepEqual((listed.body as { queries: unknown[] }).queries, []);
});
