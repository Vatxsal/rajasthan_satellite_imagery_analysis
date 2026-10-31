import assert from "node:assert/strict";
import test from "node:test";
import { CLASS } from "../lib/analysis/config";
import { EVENTS_PAGE_LIMIT_MAX, eventId, pageEvents } from "../lib/analysis/events";
import { buildSummaryPrompt } from "../lib/analysis/prompt";
import { makeAnalysisGrid } from "../lib/analysis/grid";
import { buildPatchVectors } from "../lib/analysis/stats";
import type { CompareStats } from "../lib/analysis/types";

/** Phase 6 (#16): stable event ids, events paging/filtering, prompt events block. */

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

test("eventId: deterministic, well-formed, distinct per patch", () => {
  const id = eventId(CLASS.vegLoss, 1, [74.86, 26.58], 36.1);
  assert.match(id, /^ev_[0-9a-f]{8}$/);
  assert.equal(id, eventId(CLASS.vegLoss, 1, [74.86, 26.58], 36.1), "same inputs → same id");
  assert.notEqual(id, eventId(CLASS.waterGain, 1, [74.86, 26.58], 36.1), "class in id");
  assert.notEqual(id, eventId(CLASS.vegLoss, 2, [74.86, 26.58], 36.1), "label in id");
  assert.notEqual(id, eventId(CLASS.vegLoss, 1, [74.87, 26.58], 36.1), "centroid in id");
  assert.notEqual(id, eventId(CLASS.vegLoss, 1, [74.86, 26.58], 36.2), "area in id");
});

test("buildPatchVectors: every feature carries a stable unique id", () => {
  const { grid, classGrid, labels } = vectorFixture();
  const pxAreaHa = (grid.metersX * grid.metersY) / 10_000;
  const aux = { tiers: null, subs: null, persist: null, shortGap: false };

  const first = buildPatchVectors(classGrid, labels, grid, pxAreaHa, aux);
  const ids = first.features.map((f) => f.id);
  assert.equal(ids.length, 2);
  for (const id of ids) assert.match(String(id), /^ev_[0-9a-f]{8}$/);
  assert.equal(new Set(ids).size, ids.length, "ids unique within a collection");
  for (const feature of first.features) {
    assert.equal(feature.properties?.id, feature.id, "properties.id mirrors Feature.id");
  }

  const second = buildPatchVectors(classGrid, labels, grid, pxAreaHa, aux);
  assert.deepEqual(
    second.features.map((f) => f.id),
    ids,
    "rebuild of the same analysis → identical ids",
  );
});

test("pageEvents: paging math, clamps and total after filtering", () => {
  const features = eventsFixture();

  const all = pageEvents(features);
  assert.equal(all.total, 4);
  assert.equal(all.items.length, 4);
  assert.equal(all.limit, 100, "default limit");

  const firstPage = pageEvents(features, { limit: 2, offset: 0 });
  assert.equal(firstPage.total, 4);
  assert.equal(firstPage.items.length, 2);
  const secondPage = pageEvents(features, { limit: 2, offset: 2 });
  assert.deepEqual(
    secondPage.items.map((f) => f.id),
    ["ev_cccccccc", "ev_dddddddd"],
  );

  const beyond = pageEvents(features, { limit: 10, offset: 99 });
  assert.equal(beyond.total, 4);
  assert.equal(beyond.items.length, 0, "offset beyond the end is empty, not an error");

  assert.equal(pageEvents(features, { limit: 0 }).limit, 1, "limit floor 1");
  assert.equal(
    pageEvents(features, { limit: 9_999 }).limit,
    EVENTS_PAGE_LIMIT_MAX,
    "limit ceiling",
  );
  assert.equal(pageEvents(features, { offset: -5 }).offset, 0, "offset floor 0");
});

test("pageEvents: classCode and minimum-confidence filters", () => {
  const features = eventsFixture();

  const veg = pageEvents(features, { classCode: CLASS.vegLoss });
  assert.equal(veg.total, 3);

  const high = pageEvents(features, { confidence: "high" });
  assert.equal(high.total, 2, "only tiered events at/above the tier");
  assert.ok(high.items.every((f) => f.properties?.confidence === "high"));

  const medium = pageEvents(features, { confidence: "medium" });
  assert.equal(medium.total, 3, "medium keeps medium + high");

  const low = pageEvents(features, { confidence: "low" });
  assert.equal(low.total, 3, "tiered events only — v1 events carry no tier");

  const combo = pageEvents(features, { classCode: CLASS.waterGain, confidence: "medium" });
  assert.equal(combo.total, 1);
  assert.equal(combo.items[0].id, "ev_cccccccc");
});

function promptStats(): CompareStats {
  return {
    metadata: {
      areaName: "Ajmer",
      areaLevel: "district",
      dateA: "2026-08-02",
      dateB: "2026-10-22",
      gapDays: 81,
      sceneA: { date: "2026-08-02", cloudCover: 3.2, satellite: "S2B", tileCount: 4 },
      sceneB: { date: "2026-10-22", cloudCover: 8.1, satellite: "S2A", tileCount: 4 },
      width: 800,
      height: 700,
      metersPerPixel: 10.4,
      coarse: false,
      sensitivity: "medium",
      minPatchHa: 0.2,
      engine: "v1",
      inputMode: "single",
      compositeWindowDays: 0,
      estimatedPu: 0,
      thresholds: {
        waterGainDMndwi: 0.15,
        waterLossDMndwi: -0.15,
        vegLossDNdvi: -0.2,
        vegGainDNdvi: 0.2,
        bareBuiltDNdbi: 0.1,
        bareBuiltDNdviMax: 0.25,
      },
      generatedAt: "2026-10-28T12:00:00.000Z",
    },
    classes: [
      { code: 0, label: "No change", color: [0, 0, 0], pixels: 500000, areaHa: 5000, areaKm2: 50, pctOfValid: 96 },
      { code: 2, label: "Vegetation loss", color: [220, 38, 38], pixels: 12000, areaHa: 120, areaKm2: 1.2, pctOfValid: 2.3 },
    ],
    validPct: 98.5,
    areaHa: 5200,
    validHa: 5122,
    changedHa: 120,
    tehsils: null,
    hotspots: [
      {
        centroid: [74.86, 26.58],
        bbox: [74.85, 26.57, 74.87, 26.59],
        areaHa: 36,
        classCode: 2,
        classLabel: "Vegetation loss",
        tehsilName: "Kishangarh",
        polygon: null,
      },
    ],
    changeBbox: [74.85, 26.57, 74.87, 26.59],
    negligible: false,
  };
}

test("summary prompt: events block replaces hotspots, still whitelisted", () => {
  const stats = promptStats();

  const hotspotPrompt = buildSummaryPrompt(stats);
  assert.match(hotspotPrompt, /Top hotspots/);
  assert.doesNotMatch(hotspotPrompt, /Change events/);

  const events: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: [
      eventFixture("ev_aaaaaaaa", CLASS.vegLoss, "high"),
      eventFixture("ev_cccccccc", CLASS.waterGain, "medium"),
    ],
  };
  const eventPrompt = buildSummaryPrompt(stats, events);
  assert.match(eventPrompt, /Change events \(2 patches, largest 2 shown\):/);
  assert.match(eventPrompt, /confidence high/);
  assert.match(eventPrompt, /36\.1 ha/);
  assert.match(eventPrompt, /26\.5800N 74\.8600E/);
  assert.doesNotMatch(eventPrompt, /Top hotspots/, "events present → hotspot block dropped");

  const emptyEvents: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  assert.match(
    buildSummaryPrompt(stats, emptyEvents),
    /Top hotspots/,
    "empty events fall back to hotspots",
  );
});
