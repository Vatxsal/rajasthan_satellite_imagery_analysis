import "./alias-hook"; // must be first: installs the "@/…" resolver before the graph loads

import assert from "node:assert/strict";
import test from "node:test";
import {
  PATTERN_CLASS_COLORS,
  PATTERN_CLASS_LABELS,
  patternClassColor,
  patternClassLabel,
  presentPatternClasses,
} from "../lib/fields/colors";
import {
  FieldsClientError,
  consumePatternLine,
  type PatternStreamHandlers,
} from "../lib/fields/client";
import { PATTERN_CLASSES } from "../lib/fields/config";
import { buildFieldsGeoJson } from "../lib/fields/mapBridge";
import type { FieldsResponse } from "../lib/fields/client";

/** Phase 3 UI helpers: class labels/colours, NDJSON frame consumption, and the
 *  boundary+pattern GeoJSON join the map fill reads. No network, no DOM. */

test("every pattern class has a label and a distinct hex colour", () => {
  assert.equal(PATTERN_CLASSES.length, 7);
  const colors = new Set<string>();
  for (const cls of PATTERN_CLASSES) {
    const label = PATTERN_CLASS_LABELS[cls];
    const color = PATTERN_CLASS_COLORS[cls];
    assert.ok(label && label.length > 0, `label for ${cls}`);
    assert.match(color, /^#[0-9A-Fa-f]{6}$/, `colour for ${cls}`);
    assert.ok(!colors.has(color), `duplicate colour for ${cls}`);
    colors.add(color);
  }
});

test("patternClassLabel/Color fall back to unclassified for unknown ids", () => {
  assert.equal(patternClassLabel("fallow"), "Fallow");
  assert.equal(patternClassLabel("nope"), "nope");
  assert.equal(patternClassColor("nope"), PATTERN_CLASS_COLORS.unclassified);
});

test("presentPatternClasses lists only non-zero counts in declaration order", () => {
  const rows = presentPatternClasses({
    fallow: 3,
    "kharif-only": 0,
    "rabi-only": 5,
    "double-cropped": 0,
    zaid: 0,
    evergreen: 0,
    unclassified: 1,
  });
  assert.deepEqual(
    rows.map((row) => row.cls),
    ["fallow", "rabi-only", "unclassified"],
  );
  assert.deepEqual(
    rows.map((row) => row.count),
    [3, 5, 1],
  );
});

// ── NDJSON frames ───────────────────────────────────────────────────────────

function handlers(): PatternStreamHandlers & {
  stages: string[];
  months: Array<{ index: number; label: string }>;
} {
  const stages: string[] = [];
  const months: Array<{ index: number; label: string }> = [];
  return {
    stages,
    months,
    onStage: (stage) => stages.push(stage),
    onMonth: (month) => months.push(month),
  };
}

test("consumePatternLine: stage and month frames report progress", () => {
  const h = handlers();
  assert.equal(consumePatternLine(JSON.stringify({ type: "stage", stage: "ndvi" }), h), null);
  assert.equal(
    consumePatternLine(JSON.stringify({ type: "month", index: 0, label: "2024-06" }), h),
    null,
  );
  assert.deepEqual(h.stages, ["ndvi"]);
  assert.deepEqual(h.months, [{ index: 0, label: "2024-06" }]);
});

test("consumePatternLine: result frame returns the payload without the type key", () => {
  const h = handlers();
  const result = consumePatternLine(
    JSON.stringify({
      type: "result",
      bbox: [0, 0, 1, 1],
      year: 2024,
      minConfidence: 69,
      months: ["2024-06"],
      count: 1,
      truncated: false,
      grouping: { enabled: false, k: null, sizes: [] },
      classes: {},
      estimatedPu: 10,
      fields: [],
    }),
    h,
  );
  assert.ok(result);
  assert.equal("type" in result, false);
  assert.equal(result.count, 1);
  assert.equal(result.year, 2024);
});

test("consumePatternLine: error frames throw FieldsClientError with the contract code", () => {
  const h = handlers();
  assert.throws(
    () =>
      consumePatternLine(
        JSON.stringify({ type: "error", code: "UPSTREAM_ERROR", message: "boom" }),
        h,
      ),
    (error: unknown) => {
      assert.ok(error instanceof FieldsClientError);
      assert.equal(error.code, "UPSTREAM_ERROR");
      assert.equal(error.message, "boom");
      return true;
    },
  );
});

// ── map GeoJSON join ────────────────────────────────────────────────────────

function fieldsState(pattern: unknown): Parameters<typeof buildFieldsGeoJson>[0] {
  const collection: FieldsResponse["fields"] = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "f-1",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
        },
        properties: { areaM2: 1000, confidence: 90 },
      },
      {
        type: "Feature",
        id: "f-2",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [2, 2],
              [3, 2],
              [3, 3],
              [2, 3],
              [2, 2],
            ],
          ],
        },
        properties: { areaM2: 2000, confidence: 80 },
      },
    ],
  };
  return { fields: collection, pattern: pattern as never };
}

test("buildFieldsGeoJson: no pattern keeps the boundary collection intact", () => {
  const state = fieldsState(null);
  const geo = buildFieldsGeoJson(state);
  assert.equal(geo.features.length, 2);
  assert.equal((geo.features[0]!.properties as { cls?: string }).cls, undefined);
});

test("buildFieldsGeoJson: pattern ids join cls/group; missing ids default unclassified", () => {
  const state = fieldsState({
    fields: [{ id: "f-1", cls: "kharif-only", group: 2, series: null, validMonths: 0, metrics: null }],
  });
  const geo = buildFieldsGeoJson(state);
  const first = geo.features[0]!.properties as { cls: string; group: number | null };
  const second = geo.features[1]!.properties as { cls: string; group: number | null };
  assert.equal(first.cls, "kharif-only");
  assert.equal(first.group, 2);
  assert.equal(second.cls, "unclassified");
  assert.equal(second.group, null);
  // Original properties survive the join.
  assert.equal((geo.features[0]!.properties as { areaM2: number }).areaM2, 1000);
});

test("buildFieldsGeoJson: empty fields → empty collection", () => {
  const geo = buildFieldsGeoJson({ fields: null, pattern: null });
  assert.equal(geo.features.length, 0);
  assert.equal(geo.type, "FeatureCollection");
});
