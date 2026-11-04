import assert from "node:assert/strict";
import test from "node:test";
import { CLASS, SUB, subLabel } from "../lib/analysis/config";
import { eventId } from "../lib/analysis/events";
import { makeAnalysisGrid } from "../lib/analysis/grid";
import { buildPatchVectors } from "../lib/analysis/stats";
import type { CompareMetadata } from "../lib/analysis/types";
import { PERSIST, TIER } from "../lib/analysis/v2/classify";
import { ensureCached, type ArtifactCacheLike } from "../lib/compare/ensureArtifact";
import {
  eventMarkerRows,
  eventsViewState,
  selectVisibleEvents,
  type CompareEventsStatus,
} from "../lib/compare/eventList";
import { analysisParamsFromMetadata, paramsToQuery, type AnalysisParams } from "../lib/compare/params";
import { compareCacheKey } from "../lib/cache";

/**
 * Events-tab contracts: list ↔ marker parity, the view-state rules that
 * fixed the "0 patches" bug, stateless recompute (ensureCached), the
 * client/server parameter round-trip behind KEY_PARAMS_MISMATCH, and the
 * globalThis singletons that survive module re-evaluation.
 */

function eventFixture(id: string, classCode: number, confidence?: string): GeoJSON.Feature {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: [74.86, 26.58] },
    properties: {
      id,
      label: 1,
      classCode,
      classLabel: classCode === CLASS.vegLoss ? "Vegetation loss" : "Water gain",
      areaHa: 36.1,
      centroid: [74.86, 26.58],
      ...(confidence ? { confidence } : {}),
    },
  };
}

function eventsFixture(): GeoJSON.Feature[] {
  return [
    eventFixture("ev_aaaaaaaa", CLASS.vegLoss, "high"),
    eventFixture("ev_bbbbbbbb", CLASS.vegLoss, "medium"),
    eventFixture("ev_cccccccc", CLASS.waterGain, "high"),
    eventFixture("ev_dddddddd", CLASS.vegLoss), // engine v1: no tier
  ];
}

function vectorFixture(): {
  grid: ReturnType<typeof makeAnalysisGrid>;
  classGrid: Uint8Array;
  labels: Int32Array;
} {
  const W = 8;
  const H = 6;
  const grid = makeAnalysisGrid([74.0, 26.0, 74.008, 26.006], W, H);
  const n = W * H;
  const classGrid = new Uint8Array(n);
  const labels = new Int32Array(n);
  for (let row = 1; row <= 2; row++) {
    for (let col = 1; col <= 3; col++) {
      const i = row * W + col;
      classGrid[i] = CLASS.vegLoss;
      labels[i] = 1;
    }
  }
  for (let row = 3; row <= 4; row++) {
    for (let col = 5; col <= 6; col++) {
      const i = row * W + col;
      classGrid[i] = CLASS.waterGain;
      labels[i] = 2;
    }
  }
  return { grid, classGrid, labels };
}

test("eventsViewState: list only with rows; error with nothing is banner-only", () => {
  // The reported bug: a failed fetch rendered the header with "0 patches".
  const errored = eventsViewState({ status: "error", error: "expired", visibleCount: 0 });
  assert.equal(errored.kind, "error");
  if (errored.kind === "error") assert.equal(errored.message, "expired");

  const fallback = eventsViewState({ status: "error", visibleCount: 0 });
  assert.equal(fallback.kind, "error");
  if (fallback.kind === "error") assert.match(fallback.message, /failed to load/i);

  // A failed Load-more with rows already loaded keeps the list (the tab
  // shows the retry banner alongside it, driven by the status).
  assert.equal(eventsViewState({ status: "error", error: "page failed", visibleCount: 3 }).kind, "list");

  assert.equal(eventsViewState({ status: "loading", visibleCount: 0 }).kind, "loading");
  assert.equal(eventsViewState({ status: "loading", visibleCount: 2 }).kind, "list");
  assert.equal(eventsViewState({ status: "idle", visibleCount: 0 }).kind, "loading");
  // A genuine zero — ready, nothing matching — is the empty state, not an error.
  assert.equal(eventsViewState({ status: "ready", visibleCount: 0 }).kind, "empty");
  assert.equal(eventsViewState({ status: "ready", visibleCount: 1 }).kind, "list");

  // Invariants over the whole matrix.
  const statuses: CompareEventsStatus[] = ["idle", "loading", "ready", "error"];
  for (const status of statuses) {
    for (const visibleCount of [0, 1, 5]) {
      const view = eventsViewState({ status, error: "boom", visibleCount });
      if (view.kind === "list") {
        assert.ok(visibleCount > 0, "the list header can never say '0 patches'");
      } else if (view.kind === "error") {
        assert.equal(status, "error", "only an error status yields the error state");
      } else if (view.kind === "empty") {
        assert.ok(status === "ready" && visibleCount === 0, "empty = ready with no matching rows");
      }
    }
  }
});

test("selectVisibleEvents and eventMarkerRows are rank-aligned for every filter/cursor", () => {
  const features = eventsFixture();
  const tiers: Array<"high" | "medium" | "low" | null> = [null, "high", "medium", "low"];

  for (const confidenceFilter of tiers) {
    for (const limit of [0, 1, 2, 3, 4, 10]) {
      const options = { confidenceFilter, limit };
      const list = selectVisibleEvents(features, options);
      const markers = eventMarkerRows(features, options);

      assert.deepEqual(
        markers.map((f) => f.id),
        list.map((f) => f.id),
        `marker rank N === list rank N (filter=${confidenceFilter}, limit=${limit})`,
      );
      assert.deepEqual(
        selectVisibleEvents(features, options),
        list,
        "same inputs → same rows in the same order (deterministic)",
      );
      assert.ok(list.length <= Math.min(limit, features.length), "cursor caps the rows");
    }
  }

  const high = selectVisibleEvents(features, { confidenceFilter: "high", limit: 100 });
  assert.equal(high.length, 2, "minimum 'high' keeps only high events");
  assert.ok(high.every((f) => f.properties?.confidence === "high"));

  const medium = selectVisibleEvents(features, { confidenceFilter: "medium", limit: 100 });
  assert.equal(medium.length, 3, "minimum 'medium' keeps medium + high, drops the v1 event");
  assert.ok(medium.every((f) => f.properties?.confidence !== "low"));

  const low = selectVisibleEvents(features, { confidenceFilter: "low", limit: 100 });
  assert.equal(low.length, 3, "minimum 'low' keeps every tiered event, drops the v1 event");

  const unfiltered = selectVisibleEvents(features, { confidenceFilter: null, limit: 100 });
  assert.deepEqual(
    unfiltered.map((f) => f.id),
    ["ev_aaaaaaaa", "ev_bbbbbbbb", "ev_cccccccc", "ev_dddddddd"],
    "no filter keeps source order (largest-first as served)",
  );
});

test("ensureCached: miss → hit → clear → miss, with identical event ids", async () => {
  const store = new Map<string, { eventIds: string[] }>();
  const ttls: number[] = [];
  const cache: ArtifactCacheLike<{ eventIds: string[] }> = {
    get: (key) => store.get(key),
    set: (key, value, ttlSeconds) => {
      store.set(key, value);
      ttls.push(ttlSeconds);
    },
  };
  const eventIds = (): string[] => [
    eventId(CLASS.vegLoss, 1, [74.86, 26.58], 36.1),
    eventId(CLASS.waterGain, 4, [74.9, 26.6], 12.4),
  ];
  let runs = 0;
  const run = async () => {
    runs += 1;
    return { eventIds: eventIds() };
  };

  const first = await ensureCached(cache, "key", run, { ttlSeconds: 120 });
  assert.equal(first.hit, false, "cold cache is a miss");
  assert.equal(runs, 1);
  assert.deepEqual(ttls, [120], "computed value stored with the requested TTL");

  const second = await ensureCached(cache, "key", run, { ttlSeconds: 120 });
  assert.equal(second.hit, true, "warm cache is a hit");
  assert.equal(runs, 1, "the compute function does not run again on a hit");
  assert.deepEqual(second.value.eventIds, first.value.eventIds);

  store.delete("key"); // TTL expiry
  const third = await ensureCached(cache, "key", run, { ttlSeconds: 120 });
  assert.equal(third.hit, false, "expired → miss again");
  assert.equal(runs, 2);
  assert.deepEqual(
    third.value.eventIds,
    first.value.eventIds,
    "the stateless recompute produces the same stable event ids",
  );
});

test("ensureCached: concurrent callers of one key share a single run", async () => {
  const store = new Map<string, { run: number }>();
  const cache: ArtifactCacheLike<{ run: number }> = {
    get: (key) => store.get(key),
    set: (key, value) => void store.set(key, value),
  };
  const inflight = new Map<string, Promise<{ run: number }>>();
  let runs = 0;
  const run = () =>
    new Promise<{ run: number }>((resolve) => {
      setTimeout(() => {
        runs += 1;
        resolve({ run: runs });
      }, 10);
    });

  const [a, b] = await Promise.all([
    ensureCached(cache, "key", run, { inflight }),
    ensureCached(cache, "key", run, { inflight }),
  ]);

  assert.equal(runs, 1, "restart + Load more + summary probe → one compute");
  assert.strictEqual(a.value, b.value, "both callers receive the same artifact");
  assert.equal(a.hit, false);
  assert.equal(b.hit, false, "joining an in-flight run is still a cache miss");
  assert.equal(inflight.size, 0, "the in-flight entry is cleared after settling");
});

test("ensureCached: a failed run rejects, caches nothing and can be retried", async () => {
  const store = new Map<string, string>();
  const cache: ArtifactCacheLike<string> = {
    get: (key) => store.get(key),
    set: (key, value) => void store.set(key, value),
  };
  const inflight = new Map<string, Promise<string>>();
  let calls = 0;

  await assert.rejects(
    ensureCached(
      cache,
      "key",
      async () => {
        calls += 1;
        throw new Error("upstream down");
      },
      { inflight },
    ),
    /upstream down/,
  );
  assert.equal(store.size, 0, "no negative value is cached");
  assert.equal(inflight.size, 0, "the failed in-flight entry is cleared");

  const retried = await ensureCached(
    cache,
    "key",
    async () => {
      calls += 1;
      return "ok";
    },
    { inflight },
  );
  assert.equal(retried.value, "ok");
  assert.equal(calls, 2, "the next call retries the compute");
});

test("params query → key: the wire round-trip re-derives the identical compareCacheKey", () => {
  const params: AnalysisParams = {
    areaId: "jodhpur",
    level: "district",
    dateA: "2024-01-05",
    dateB: "2024-02-10",
    sensitivity: "high",
    minPatchHa: 0.25,
    inputMode: "composite",
    compositeWindowDays: 7,
  };

  const query = paramsToQuery(params);
  assert.deepEqual(
    Array.from(query.keys()).sort(),
    ["areaId", "compositeWindowDays", "dateA", "dateB", "inputMode", "level", "minPatchHa", "sensitivity"],
    "exactly the fields the key derives from — nothing dropped, nothing extra",
  );

  // What the server does with an incoming query: parse the strings, coerce
  // the numbers, rebuild the key — it must equal the direct derivation.
  const derivedFromWire = (): string => {
    const wire = new URLSearchParams(query.toString());
    return compareCacheKey({
      areaId: wire.get("areaId") ?? "",
      level: wire.get("level") ?? "",
      dateA: wire.get("dateA") ?? "",
      dateB: wire.get("dateB") ?? "",
      sensitivity: wire.get("sensitivity") ?? "",
      minPatchHa: Number(wire.get("minPatchHa")),
      engine: "v2",
      inputMode: wire.get("inputMode") ?? "",
      compositeWindowDays: Number(wire.get("compositeWindowDays")),
    });
  };
  const direct = compareCacheKey({ ...params, engine: "v2" });
  assert.equal(derivedFromWire(), direct);

  // Numeric string coercion is stable across the legal ranges — a0.30000000004
  // key would break KEY_PARAMS_MISMATCH for identical settings.
  for (const minPatchHa of [0.01, 0.2, 0.35, 1, 10]) {
    for (const compositeWindowDays of [0, 7, 15]) {
      const variant: AnalysisParams = { ...params, minPatchHa, compositeWindowDays };
      const wire = new URLSearchParams(paramsToQuery(variant).toString());
      assert.equal(
        compareCacheKey({
          areaId: wire.get("areaId") ?? "",
          level: wire.get("level") ?? "",
          dateA: wire.get("dateA") ?? "",
          dateB: wire.get("dateB") ?? "",
          sensitivity: wire.get("sensitivity") ?? "",
          minPatchHa: Number(wire.get("minPatchHa")),
          engine: "v2",
          inputMode: wire.get("inputMode") ?? "",
          compositeWindowDays: Number(wire.get("compositeWindowDays")),
        }),
        compareCacheKey({ ...variant, engine: "v2" }),
        `round-trip key differs for minPatchHa=${minPatchHa}/${compositeWindowDays}d`,
      );
    }
  }
});

test("analysisParamsFromMetadata maps metadata onto the query fields", () => {
  const metadata = {
    areaId: "sikar",
    areaLevel: "tehsil",
    dateA: "2023-06-01",
    dateB: "2023-07-01",
    sensitivity: "medium",
    minPatchHa: 0.35,
    inputMode: "single",
    compositeWindowDays: 0,
  } as unknown as CompareMetadata;

  assert.deepEqual(analysisParamsFromMetadata(metadata), {
    areaId: "sikar",
    level: "tehsil", // metadata.areaLevel → wire "level"
    dateA: "2023-06-01",
    dateB: "2023-07-01",
    sensitivity: "medium",
    minPatchHa: 0.35,
    inputMode: "single",
    compositeWindowDays: 0,
  });
});

test("sharedInstance/compare caches survive module re-evaluation", () => {
  // next dev HMR and per-route bundling evaluate these modules twice; the
  // instances live on globalThis so both evaluations see the same objects.
  const first = require("../lib/singleton") as typeof import("../lib/singleton");
  delete require.cache[require.resolve("../lib/singleton")];
  const second = require("../lib/singleton") as typeof import("../lib/singleton");

  const a = first.sharedInstance("rse.test.eventsTab", () => ({ n: 1 }));
  const b = second.sharedInstance("rse.test.eventsTab", () => ({ n: 2 }));
  assert.strictEqual(a, b, "the factory runs once per key across re-evaluations");

  const cacheFirst = require("../lib/cache") as typeof import("../lib/cache");
  delete require.cache[require.resolve("../lib/cache")];
  const cacheSecond = require("../lib/cache") as typeof import("../lib/cache");
  assert.strictEqual(
    cacheFirst.compareResultCache,
    cacheSecond.compareResultCache,
    "the artifact cache is shared through globalThis, not module state",
  );
});

test("buildPatchVectors: v2 evidence + tehsil props ride on every event", () => {
  const { grid, classGrid, labels } = vectorFixture();
  const pxAreaHa = (grid.metersX * grid.metersY) / 10_000;
  const n = labels.length;

  // Zone raster: zone value = index+1 (rasterizeZones convention).
  const zones = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    zones[i] = labels[i] === 1 ? 1 : labels[i] === 2 ? 2 : 0;
  }
  const zoneMeta = [
    { id: "t_sikar", name: "Sikar" },
    { id: "t_jaipur", name: "Jaipur" },
  ];

  // v2 evidence: veg patch = high tier + harvest sub + transient majority;
  // water patch = low tier, no sub, persistent.
  const tiers = new Uint8Array(n);
  const subs = new Uint8Array(n);
  const persist = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i] === 1) {
      tiers[i] = TIER.high;
      subs[i] = SUB.vegLossHarvest;
      persist[i] = PERSIST.transient;
    } else if (labels[i] === 2) {
      tiers[i] = TIER.low;
      persist[i] = PERSIST.yes;
    }
  }

  const aux = { tiers, subs, persist, shortGap: false };
  const collection = buildPatchVectors(classGrid, labels, grid, pxAreaHa, aux, undefined, zones, zoneMeta);
  assert.equal(collection.features.length, 2);

  const veg = collection.features.find((f) => f.properties?.classCode === CLASS.vegLoss);
  const water = collection.features.find((f) => f.properties?.classCode === CLASS.waterGain);
  assert.ok(veg, "the vegetation-loss event exists");
  assert.ok(water, "the water-gain event exists");

  const vegProps = (veg.properties ?? {}) as Record<string, unknown>;
  assert.equal(vegProps.confidence, "high", "majority tier of the patch");
  assert.equal(vegProps.subLabel, subLabel(SUB.vegLossHarvest), "majority sub-label");
  assert.deepEqual(vegProps.tags, ["transient", "crop-cycle"], "evidence tags, canonical order");
  assert.equal(vegProps.tehsilName, "Sikar", "majority zone name");

  const waterProps = (water.properties ?? {}) as Record<string, unknown>;
  assert.equal(waterProps.confidence, "low");
  assert.equal(waterProps.subLabel, null, "no sub-label is an explicit null, not a missing key");
  assert.deepEqual(waterProps.tags, []);
  assert.equal(waterProps.tehsilName, "Jaipur");
});

test("buildPatchVectors: engine v1 carries no evidence or tehsil props", () => {
  const { grid, classGrid, labels } = vectorFixture();
  const pxAreaHa = (grid.metersX * grid.metersY) / 10_000;
  const aux = { tiers: null, subs: null, persist: null, shortGap: false };

  const collection = buildPatchVectors(classGrid, labels, grid, pxAreaHa, aux);
  assert.ok(collection.features.length > 0);
  for (const feature of collection.features) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    assert.equal("confidence" in props, false, "v1 has no confidence");
    assert.equal("subLabel" in props, false, "v1 has no sub-label");
    assert.equal("tags" in props, false, "v1 has no evidence tags");
    assert.equal("tehsilName" in props, false, "no zones raster → no tehsil name");
    assert.match(String(feature.id), /^ev_[0-9a-f]{8}$/, "stable event id");
  }
});
