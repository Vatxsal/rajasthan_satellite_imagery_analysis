import "./alias-hook"; // must be first: installs the "@/…" resolver before the graph loads

import assert from "node:assert/strict";
import test from "node:test";
import {
  FILL_OPACITY,
  FIELDS_LINE,
  GROUP_COLORS,
  classColorExpression,
  colorByExpression,
  confidenceColorExpression,
  fieldsFillOpacityExpression,
  fieldsLineOpacityExpression,
  fieldsLineWidthExpression,
  fillLayerVisibility,
  groupColor,
  groupColorExpression,
} from "../lib/fields/style";
import {
  agriYearInProgress,
  areaHaLabel,
  meanSeriesByClass,
  meanSeriesByGroup,
  patternClassStats,
  provisionalNote,
  puLabel,
  scopeText,
  shareLabel,
} from "../lib/fields/summary";
import { PATTERN_CLASS_COLORS } from "../lib/fields/colors";
import { PATTERN_CLASSES, type PatternClass } from "../lib/fields/config";
import { classifySeries, type PatternMetrics } from "../lib/fields/pattern";
import { useFieldsStore } from "../store/useFieldsStore";

/** Phase 2 map style + panel summaries: colour-by expressions (match nesting
 *  is the root-cause regression), legend filters, agri-year progress with the
 *  inProgress label override, scope/PU/share labels, and small-multiple means.
 *  No network, no DOM, no map. */

// ── colour mapping ──────────────────────────────────────────────────────────

test("classColorExpression: match input stays ONE nested [\"get\",\"cls\"] argument", () => {
  const expr = classColorExpression() as unknown[];
  assert.equal(expr[0], "match");
  // Regression: the root cause flattened ["get","cls"] across the arms, so
  // MapLibre read `cls` as the first label and rejected the paint property.
  assert.deepEqual(expr[1], ["get", "cls"], "input expression is one array element");
  assert.equal(expr.length, 2 + PATTERN_CLASSES.length * 2 + 1);
});

test("classColorExpression: every class arm pairs with its chip colour, default last", () => {
  const expr = classColorExpression() as unknown[];
  PATTERN_CLASSES.forEach((cls, index) => {
    assert.equal(expr[2 + index * 2], cls, `label ${index}`);
    assert.equal(expr[3 + index * 2], PATTERN_CLASS_COLORS[cls], `colour for ${cls}`);
  });
  assert.equal(expr[expr.length - 1], PATTERN_CLASS_COLORS.unclassified);
});

test("classColorExpression: custom fallback replaces the default colour", () => {
  const expr = classColorExpression("#123456") as unknown[];
  assert.equal(expr[expr.length - 1], "#123456");
});

test("groupColorExpression: numeric arms over k groups, unclassified default", () => {
  const expr = groupColorExpression(3) as unknown[];
  assert.equal(expr[0], "match");
  assert.deepEqual(expr[1], ["get", "group"]);
  for (let group = 0; group < 3; group++) {
    assert.equal(expr[2 + group * 2], group);
    assert.equal(expr[3 + group * 2], GROUP_COLORS[group]);
  }
  assert.equal(expr[expr.length - 1], PATTERN_CLASS_COLORS.unclassified);
  assert.equal(expr.length, 2 + 3 * 2 + 1);
});

test("groupColor wraps past the palette and stays hex", () => {
  assert.equal(groupColor(0), GROUP_COLORS[0]);
  assert.equal(groupColor(GROUP_COLORS.length), GROUP_COLORS[0]);
  assert.equal(groupColor(-1), GROUP_COLORS[GROUP_COLORS.length - 1]);
  for (const colour of GROUP_COLORS) assert.match(colour, /^#[0-9A-Fa-f]{6}$/);
});

test("confidenceColorExpression: interpolate over coalesce(confidence, 0)", () => {
  const expr = confidenceColorExpression() as unknown[];
  assert.equal(expr[0], "interpolate");
  assert.deepEqual(expr[2], ["coalesce", ["get", "confidence"], 0]);
  const json = JSON.stringify(expr);
  assert.ok(json.includes("#D55E00"), "low end");
  assert.ok(json.includes("#009E73"), "high end");
});

test("colorByExpression: mode + data decide the expression, missing data falls back", () => {
  const full = { hasPattern: true, groupCount: 4, confidenceAvailable: true };

  const byPattern = colorByExpression("pattern", full) as unknown[];
  assert.equal(byPattern[0], "match");
  const byGroup = colorByExpression("group", full) as unknown[];
  assert.equal(byGroup[0], "match");
  assert.deepEqual(byGroup[1], ["get", "group"]);
  const byConfidence = colorByExpression("confidence", full) as unknown[];
  assert.equal(byConfidence[0], "interpolate");

  // confidence mode without confidence → pattern colours
  const noConfidence = colorByExpression("confidence", {
    ...full,
    confidenceAvailable: false,
  }) as unknown[];
  assert.equal(noConfidence[0], "match");
  assert.deepEqual(noConfidence[1], ["get", "cls"]);

  // group mode with grouping unavailable → pattern colours
  const noGroups = colorByExpression("group", { ...full, groupCount: 0 }) as unknown[];
  assert.deepEqual(noGroups[1], ["get", "cls"]);

  // no pattern at all → null (caller keeps the plain boundary colour)
  assert.equal(
    colorByExpression("pattern", { hasPattern: false, groupCount: 0, confidenceAvailable: false }),
    null,
  );
  assert.equal(
    colorByExpression("confidence", { hasPattern: false, groupCount: 0, confidenceAvailable: false }),
    null,
  );
});

// ── filters, opacity, render mode ───────────────────────────────────────────

test("fill opacity: base sits inside the 15–25 % spec band, emphasis beats base", () => {
  assert.ok(
    FILL_OPACITY.base >= 0.15 && FILL_OPACITY.base <= 0.25,
    `base ${FILL_OPACITY.base} inside 0.15–0.25`,
  );
  assert.ok(FILL_OPACITY.hover > FILL_OPACITY.base, "hover is stronger");
  assert.ok(FILL_OPACITY.selected > FILL_OPACITY.hover, "selection is stronger still");
  assert.ok(FILL_OPACITY.flash > FILL_OPACITY.selected, "flash is the loudest");
  assert.ok(FILL_OPACITY.muted < FILL_OPACITY.plain, "filtered-out ghost is quieter than plain");
  assert.ok(FIELDS_LINE.selectedWidth > FIELDS_LINE.width, "selected outline is thicker");
});

test("fieldsFillOpacityExpression: feature-state case with plain numeric base", () => {
  const expr = fieldsFillOpacityExpression({ base: FILL_OPACITY.base }) as unknown[];
  assert.equal(expr[0], "case");
  assert.ok(JSON.stringify(expr).includes('"feature-state","hover"'));
  assert.ok(JSON.stringify(expr).includes('"feature-state","selected"'));
  assert.ok(JSON.stringify(expr).includes('"feature-state","flash"'));
  assert.equal(expr[expr.length - 1], FILL_OPACITY.base, "no filter → base at the end");
});

test("fieldsFillOpacityExpression: class filter guards base vs muted ghost", () => {
  const active: PatternClass[] = ["fallow", "zaid"];
  const expr = fieldsFillOpacityExpression({ base: 0.18, active }) as unknown[];
  const baseBranch = expr[expr.length - 1] as unknown[];
  assert.equal(baseBranch[0], "case");
  assert.deepEqual(baseBranch[1], ["in", ["get", "cls"], ["literal", ["fallow", "zaid"]]]);
  assert.equal(baseBranch[2], 0.18, "listed classes keep the base wash");
  assert.equal(baseBranch[3], FILL_OPACITY.muted, "the rest ghost out");
  // Empty filter behaves like no filter.
  const cleared = fieldsFillOpacityExpression({ base: 0.18, active: [] }) as unknown[];
  assert.equal(cleared[cleared.length - 1], 0.18);
});

test("line width/opacity: state emphasis plus filtered-out fade", () => {
  const width = fieldsLineWidthExpression() as unknown[];
  assert.equal(width[0], "case");
  assert.equal(width[width.length - 1], FIELDS_LINE.width);

  const plain = fieldsLineOpacityExpression({}) as unknown[];
  assert.equal(plain[plain.length - 1], FIELDS_LINE.opacity);

  const filtered = fieldsLineOpacityExpression({ active: ["rabi-only"] }) as unknown[];
  const base = filtered[filtered.length - 1] as unknown[];
  assert.deepEqual(base[1], ["in", ["get", "cls"], ["literal", ["rabi-only"]]]);
  assert.equal(base[3], FIELDS_LINE.mutedOpacity);
});

test("fillLayerVisibility: outline-only mode hides the wash entirely", () => {
  assert.equal(fillLayerVisibility(true, "fill"), "visible");
  assert.equal(fillLayerVisibility(true, "outline"), "none");
  assert.equal(fillLayerVisibility(false, "fill"), "none");
});

// ── incomplete agri year ────────────────────────────────────────────────────

test("agriYearInProgress: 2026 runs until 1 June 2027, past years are done", () => {
  const midRun = new Date("2026-11-15T00:00:00Z");
  assert.equal(agriYearInProgress(2026, midRun), true);
  assert.equal(agriYearInProgress(2025, midRun), false);
  assert.equal(agriYearInProgress(2024, midRun), false);

  assert.equal(agriYearInProgress(2026, new Date("2027-05-31T23:59:59Z")), true);
  assert.equal(agriYearInProgress(2026, new Date("2027-06-01T00:00:00Z")), false);
});

test("provisionalNote: banner only while the agri year is unfinished", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  assert.equal(provisionalNote(2026, now), "Provisional: rabi/zaid not complete yet");
  assert.equal(provisionalNote(2025, now), null);
});

function metrics(overrides: Partial<PatternMetrics> = {}): PatternMetrics {
  return {
    mean: 0.5,
    min: 0.2,
    max: 0.7,
    peakMonth: 3,
    greenMonths: 6,
    kharifMean: 0.6,
    rabiMean: 0.4,
    zaidMean: 0.3,
    ...overrides,
  };
}

const SINGLE_PEAK = [0.2, 0.4, 0.6, 0.7, 0.6, 0.5, 0.4, 0.35, 0.3, 0.3, 0.28, 0.26];

test("classifySeries: inProgress demotes fallow and kharif-only to unclassified", () => {
  // Fallow: nothing grew.
  const fallowMetrics = metrics({ max: 0.1, mean: 0.05, kharifMean: 0.1, rabiMean: 0.1 });
  assert.equal(classifySeries(SINGLE_PEAK, fallowMetrics), "fallow");
  assert.equal(classifySeries(SINGLE_PEAK, fallowMetrics, { inProgress: true }), "unclassified");

  // Kharif-only: monsoon mean ≥ rabi mean, single peak outside Apr/May.
  assert.equal(classifySeries(SINGLE_PEAK, metrics()), "kharif-only");
  assert.equal(classifySeries(SINGLE_PEAK, metrics(), { inProgress: true }), "unclassified");
});

test("classifySeries: inProgress keeps rabi-only and evergreen (already observed)", () => {
  const rabi = metrics({ peakMonth: 7, kharifMean: 0.3, rabiMean: 0.6 });
  const rabiSmooth = [0.25, 0.3, 0.3, 0.3, 0.4, 0.5, 0.6, 0.7, 0.65, 0.5, 0.4, 0.35];
  assert.equal(classifySeries(rabiSmooth, rabi), "rabi-only");
  assert.equal(classifySeries(rabiSmooth, rabi, { inProgress: true }), "rabi-only");

  const evergreen = metrics({ min: 0.5, max: 0.6, mean: 0.55 });
  assert.equal(classifySeries(SINGLE_PEAK, evergreen), "evergreen");
  assert.equal(classifySeries(SINGLE_PEAK, evergreen, { inProgress: true }), "evergreen");
});

test("classifySeries: default is the completed-year behaviour", () => {
  assert.equal(classifySeries(SINGLE_PEAK, metrics()), "kharif-only");
  assert.equal(classifySeries(SINGLE_PEAK, metrics(), { inProgress: false }), "kharif-only");
});

// ── legend stats & small multiples ──────────────────────────────────────────

const ROWS = [
  { id: "a", cls: "fallow" as PatternClass, group: null, series: [0.1, 0.2, 0.3] },
  { id: "b", cls: "fallow" as PatternClass, group: 0, series: [0.3, 0.4, 0.5] },
  { id: "c", cls: "rabi-only" as PatternClass, group: 1, series: [0.6, 0.7, 0.8] },
  { id: "d", cls: "unclassified" as PatternClass, group: null, series: null },
];

test("patternClassStats: count, joined area and area share in declaration order", () => {
  const areas = new Map([
    ["a", 10_000],
    ["b", 30_000],
    ["c", 40_000],
    ["d", 20_000],
  ]);
  const stats = patternClassStats(ROWS, areas);
  assert.deepEqual(
    stats.map((stat) => stat.cls),
    ["fallow", "rabi-only", "unclassified"],
  );
  const fallow = stats[0]!;
  assert.equal(fallow.count, 2);
  assert.equal(fallow.areaM2, 40_000);
  assert.equal(fallow.share, 0.4, "40 000 of 100 000 m²");
  assert.equal(stats[1]!.share, 0.4);
  assert.equal(stats[2]!.count, 1);
  assert.equal(stats[2]!.share, 0.2);
});

test("patternClassStats: unknown areas count but contribute no area; no areas → count share", () => {
  const partial = patternClassStats(ROWS, new Map([["a", 10_000]]));
  assert.equal(partial.find((stat) => stat.cls === "fallow")?.areaM2, 10_000);

  const none = patternClassStats(ROWS, new Map());
  const fallow = none.find((stat) => stat.cls === "fallow")!;
  assert.equal(fallow.areaM2, 0);
  assert.equal(fallow.share, 0.5, "2 of 4 rows");
});

test("patternClassStats: classes with zero rows are omitted", () => {
  const stats = patternClassStats([{ id: "a", cls: "zaid" }], new Map());
  assert.deepEqual(
    stats.map((stat) => stat.cls),
    ["zaid"],
  );
});

test("meanSeriesByClass: month-wise mean, declaration order, null series skipped", () => {
  const means = meanSeriesByClass(ROWS);
  assert.deepEqual(
    means.map((row) => row.cls),
    ["fallow", "rabi-only"],
  );
  assert.deepEqual(means[0]!.mean, [0.2, 0.3, 0.4], "mean of the two fallow curves");
  assert.equal(means[0]!.n, 2);
  assert.deepEqual(means[1]!.mean, [0.6, 0.7, 0.8]);
});

test("meanSeriesByGroup: grouped rows only, ascending group id, g-keyed", () => {
  const means = meanSeriesByGroup(ROWS);
  assert.deepEqual(
    means.map((row) => row.key),
    ["g0", "g1"],
  );
  assert.deepEqual(
    means.map((row) => row.group),
    [0, 1],
  );
  assert.equal(means[0]!.n, 1);
});

// ── labels ──────────────────────────────────────────────────────────────────

test("scopeText: current view and selected tehsil captions", () => {
  assert.equal(scopeText("viewport", 2.4333), "Analysis area: current view (2.43 km²)");
  assert.equal(scopeText("viewport", null), "Analysis area: current view (—)");
  assert.equal(
    scopeText("tehsil", 17.44, "Bassi"),
    "Analysis area: selected tehsil — Bassi (17.44 km²)",
  );
  assert.equal(scopeText("tehsil", 17.44), "Analysis area: selected tehsil (17.44 km²)");
});

test("puLabel: one decimal, honest 'about' prefix", () => {
  assert.equal(puLabel(17.666), "about 17.7 PU");
  assert.equal(puLabel(17.05), "about 17.1 PU");
  assert.equal(puLabel(Number.NaN), "about 0.0 PU");
});

test("shareLabel/areaHaLabel: whole percent, adaptive hectares", () => {
  assert.equal(shareLabel(0.234), "23%");
  assert.equal(shareLabel(1.5), "100%", "clamped");
  assert.equal(shareLabel(-1), "0%", "clamped");
  assert.equal(areaHaLabel(8_000), "0.8 ha");
  assert.equal(areaHaLabel(150_000), "15 ha");
  assert.equal(areaHaLabel(1_250_000), "125 ha");
  assert.equal(areaHaLabel(0), "—");
});

// ── legend filter store semantics ───────────────────────────────────────────

test("fields store: colour-by/render defaults and view settings for Phase 2", () => {
  useFieldsStore.setState({ colorBy: "pattern", renderMode: "fill", filterClasses: ["zaid"] });
  const state = useFieldsStore.getState();
  assert.equal(state.year, 2025, "default is the last completed agri year");
  assert.equal(state.colorBy, "pattern");
  assert.equal(state.renderMode, "fill");
  assert.deepEqual(state.filterClasses, ["zaid"]);

  // First click isolates, later clicks add/remove, empty clears the filter.
  useFieldsStore.getState().clearClassFilter();
  useFieldsStore.getState().toggleClassFilter("fallow");
  assert.deepEqual(useFieldsStore.getState().filterClasses, ["fallow"]);
  useFieldsStore.getState().toggleClassFilter("zaid");
  assert.deepEqual(useFieldsStore.getState().filterClasses, ["fallow", "zaid"]);
  useFieldsStore.getState().toggleClassFilter("fallow");
  assert.deepEqual(useFieldsStore.getState().filterClasses, ["zaid"]);
  useFieldsStore.getState().toggleClassFilter("zaid");
  assert.deepEqual(useFieldsStore.getState().filterClasses, [], "last removal clears");

  // "Only" replaces, "Show all" clears.
  useFieldsStore.getState().onlyClassFilter("evergreen");
  assert.deepEqual(useFieldsStore.getState().filterClasses, ["evergreen"]);
  useFieldsStore.getState().clearClassFilter();
  assert.deepEqual(useFieldsStore.getState().filterClasses, []);

  // A cleared pattern run drops its filter too.
  useFieldsStore.setState({
    filterClasses: ["zaid"],
    pattern: {
      bbox: [0, 0, 1, 1],
      year: 2025,
      minConfidence: 69,
      months: [],
      count: 0,
      truncated: false,
      grouping: { enabled: false, k: null, sizes: [] },
      classes: {} as Record<PatternClass, number>,
      estimatedPu: 1,
      fields: [],
    },
  });
  useFieldsStore.getState().clearPattern();
  assert.deepEqual(useFieldsStore.getState().filterClasses, []);
});
