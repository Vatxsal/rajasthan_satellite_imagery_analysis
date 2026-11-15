import "./alias-hook"; // must be first: installs the "@/…" resolver before the library graph loads

import assert from "node:assert/strict";
import test from "node:test";
import {
  isQueryRepoError,
  localRepository,
  supabaseRepository,
  type QueryRepoErrorCode,
  type QueryRepository,
  type SavedQueryInput,
  type StorageLike,
} from "../lib/queries/repository";
import { createFakePostgrest } from "./postgrest-fake";

/** Contract suite run against BOTH adapters: identical expectations for
 *  create/list/get/update/delete/touchRun, unique names, limits, validation
 *  and owner isolation — the Supabase side runs on an in-memory PostgREST
 *  fake so owner filters and 23505 conflicts are exercised for real. */

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

interface Harness {
  /** Repository bound to an owner; both owners share one backend per harness. */
  make(owner: string, limit?: number): QueryRepository;
}

const BACKENDS: Array<{ label: string; makeHarness: () => Harness }> = [
  {
    label: "local",
    makeHarness: () => {
      const storage = fakeStorage();
      return { make: (owner, limit) => localRepository(owner, { storage, limit }) };
    },
  },
  {
    label: "supabase",
    makeHarness: () => {
      const fake = createFakePostgrest();
      return {
        make: (owner, limit) =>
          supabaseRepository(
            { url: "http://supabase.test", serviceRoleKey: "contract-test-key" },
            owner,
            { fetchImpl: fake.fetch, limit },
          ),
      };
    },
  },
];

const BASE: SavedQueryInput = {
  name: "Kharif watch",
  area: { level: "district", areaId: "d-jaisalmer", name: "Jaisalmer" },
  dateRange: { mode: "relative", days: 120 },
  maxCloud: 25,
  composite: "false-color",
};

const GHOST_ID = "00000000-0000-4000-8000-000000000000";

async function rejectsCode(fn: () => Promise<unknown>, code: QueryRepoErrorCode): Promise<void> {
  await assert.rejects(
    fn,
    (error: unknown) => isQueryRepoError(error) && error.code === code,
    `expected QueryRepoError ${code}`,
  );
}

for (const { label, makeHarness } of BACKENDS) {
  test(`${label}: starts empty and unknown ids resolve to null/false`, async () => {
    const repo = makeHarness().make("alice");
    assert.equal(repo.store, label);
    assert.deepEqual(await repo.list(), []);
    assert.equal(await repo.get(GHOST_ID), null);
    assert.equal(await repo.delete(GHOST_ID), false);
    assert.equal(await repo.touchRun(GHOST_ID), null);
    assert.equal(await repo.update(GHOST_ID, { name: "Ghost" }), null);
  });

  test(`${label}: create stores cleaned input with defaults`, async () => {
    const repo = makeHarness().make("alice");
    const created = await repo.create({ ...BASE, name: "  Kharif\u0000 watch  " });
    assert.equal(created.name, "Kharif watch");
    assert.equal(created.description, "");
    assert.equal(created.pinned, false);
    assert.equal(created.runCount, 0);
    assert.equal(created.lastRunAt, null);
    assert.ok(Number.isFinite(Date.parse(created.createdAt)));
    assert.ok(Number.isFinite(Date.parse(created.updatedAt)));

    const listed = await repo.list();
    assert.equal(listed.length, 1);
    assert.deepEqual(await repo.get(created.id), created);
  });

  test(`${label}: duplicate names conflict case-insensitively`, async () => {
    const repo = makeHarness().make("alice");
    await repo.create(BASE);
    await rejectsCode(() => repo.create({ ...BASE, name: "KHARIF WATCH" }), "NAME_TAKEN");
    await rejectsCode(() => repo.create({ ...BASE, name: "  kharif watch " }), "NAME_TAKEN");
  });

  test(`${label}: the role cap rejects the next create`, async () => {
    const repo = makeHarness().make("limited", 2);
    await repo.create({ ...BASE, name: "One" });
    await repo.create({ ...BASE, name: "Two" });
    await rejectsCode(() => repo.create({ ...BASE, name: "Three" }), "LIMIT_REACHED");
    assert.equal((await repo.list()).length, 2);
  });

  test(`${label}: invalid inputs are rejected`, async () => {
    const repo = makeHarness().make("alice");
    await rejectsCode(() => repo.create({ ...BASE, maxCloud: 150 }), "INVALID_INPUT");
    await rejectsCode(() => repo.create({ ...BASE, bogus: true } as SavedQueryInput), "INVALID_INPUT");
    await rejectsCode(
      () => repo.create({ ...BASE, dateRange: { mode: "absolute", from: "2026-01-10" } }),
      "INVALID_INPUT",
    );
    await rejectsCode(
      () =>
        repo.create({
          ...BASE,
          dateRange: { mode: "absolute", from: "2026-02-01", to: "2026-01-01" },
        }),
      "INVALID_INPUT",
    );
    await rejectsCode(() => repo.create({ ...BASE, name: "" }), "INVALID_INPUT");
    assert.deepEqual(await repo.list(), []);
  });

  test(`${label}: update patches fields, guards uniqueness, 404s unknown ids`, async () => {
    const repo = makeHarness().make("alice");
    const first = await repo.create(BASE);
    await repo.create({ ...BASE, name: "Second watch" });

    const renamed = await repo.update(first.id, { name: "Renamed", pinned: true });
    assert.ok(renamed);
    assert.equal(renamed.name, "Renamed");
    assert.equal(renamed.pinned, true);
    assert.equal(renamed.maxCloud, BASE.maxCloud, "untouched fields survive the patch");
    assert.equal((await repo.get(first.id))?.name, "Renamed");

    await rejectsCode(() => repo.update(first.id, { name: "second watch" }), "NAME_TAKEN");
    await rejectsCode(() => repo.update(first.id, { maxCloud: 200 }), "INVALID_INPUT");
    assert.equal(await repo.update(GHOST_ID, { name: "Ghost" }), null);
    assert.equal((await repo.list()).length, 2, "failed updates never persist");
  });

  test(`${label}: touchRun counts runs and stamps lastRunAt`, async () => {
    const repo = makeHarness().make("alice");
    const created = await repo.create(BASE);
    const first = await repo.touchRun(created.id);
    assert.ok(first);
    assert.equal(first.runCount, 1);
    assert.ok(first.lastRunAt);
    const second = await repo.touchRun(created.id);
    assert.ok(second);
    assert.equal(second.runCount, 2);
    assert.equal(await repo.touchRun(GHOST_ID), null);
  });

  test(`${label}: delete removes the row exactly once`, async () => {
    const repo = makeHarness().make("alice");
    const created = await repo.create(BASE);
    assert.equal(await repo.delete(created.id), true);
    assert.equal(await repo.delete(created.id), false);
    assert.equal(await repo.get(created.id), null);
    assert.deepEqual(await repo.list(), []);
  });

  test(`${label}: a second owner cannot list, read, update, delete or run the first's queries`, async () => {
    const harness = makeHarness();
    const alice = harness.make("alice");
    const created = await alice.create(BASE);

    const bob = harness.make("bob");
    assert.deepEqual(await bob.list(), []);
    assert.equal(await bob.get(created.id), null);
    assert.equal(await bob.update(created.id, { name: "Stolen" }), null);
    assert.equal(await bob.delete(created.id), false);
    assert.equal(await bob.touchRun(created.id), null);

    const stillAlice = await alice.get(created.id);
    assert.ok(stillAlice);
    assert.equal(stillAlice.name, BASE.name, "the victim's row is untouched");
    assert.equal((await alice.list()).length, 1);
  });

  test(`${label}: date ranges normalize on save`, async () => {
    const repo = makeHarness().make("alice");
    const relative = await repo.create({
      ...BASE,
      dateRange: { mode: "relative", days: 60, from: "2026-01-01", to: "2026-01-31" },
    });
    assert.deepEqual(relative.dateRange, { mode: "relative", days: 60 });

    const absolute = await repo.create({
      ...BASE,
      name: "Monsoon window",
      dateRange: { mode: "absolute", from: "2026-06-01", to: "2026-09-30", days: 900 },
    });
    assert.deepEqual(absolute.dateRange, { mode: "absolute", from: "2026-06-01", to: "2026-09-30" });
    assert.equal((await repo.list()).length, 2);
  });
}

test("local: corrupt storage degrades to the valid subset", async () => {
  const storage = fakeStorage();
  const key = "rie:queries:v1:corrupt-owner";
  const repo = localRepository("corrupt-owner", { storage });
  const valid = await repo.create(BASE);

  storage.setItem(key, "{not json");
  assert.deepEqual(await repo.list(), [], "unparseable payload → empty list");

  storage.setItem(key, JSON.stringify([{ id: 123 }, valid, "junk", { name: "half entry" }]));
  const listed = await repo.list();
  assert.equal(listed.length, 1, "only the fully valid entry survives");
  assert.equal(listed[0].id, valid.id);

  storage.setItem(key, JSON.stringify({ not: "an array" }));
  assert.deepEqual(await repo.list(), []);
});

test("local: unusable storage falls back to the in-memory session", async () => {
  const denied: StorageLike = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => {
      throw new Error("denied");
    },
  };
  const repo = localRepository("memory-fallback-owner", { storage: denied });
  const created = await repo.create(BASE);
  const secondWind = localRepository("memory-fallback-owner", { storage: denied });
  const listed = await secondWind.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);
});

test("supabase: every statement is owner-scoped and authenticated", async () => {
  const fake = createFakePostgrest();
  const repo = supabaseRepository(
    { url: "http://supabase.test", serviceRoleKey: "contract-test-key" },
    "alice",
    { fetchImpl: fake.fetch },
  );
  await repo.list();
  const created = await repo.create(BASE);
  await repo.get(created.id);
  await repo.update(created.id, { pinned: true });
  await repo.touchRun(created.id);
  await repo.delete(created.id);

  assert.ok(fake.calls.length >= 6);
  for (const call of fake.calls) {
    assert.equal(call.headers.apikey, "contract-test-key");
    assert.equal(call.headers.authorization, "Bearer contract-test-key");
    if (call.method === "POST") {
      assert.equal((call.body as { owner?: string }).owner, "alice");
    } else {
      assert.match(call.url, /owner=eq\.alice/, `${call.method} ${call.url} must scope the owner`);
    }
  }
});

test("supabase: network failures map to UPSTREAM_ERROR", async () => {
  const repo = supabaseRepository(
    { url: "http://supabase.test", serviceRoleKey: "contract-test-key" },
    "alice",
    {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    },
  );
  await rejectsCode(() => repo.list(), "UPSTREAM_ERROR");
  await rejectsCode(() => repo.create(BASE), "UPSTREAM_ERROR");
});
