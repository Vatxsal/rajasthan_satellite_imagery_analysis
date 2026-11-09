/**
 * npm run phase6 — Phase 6 deliverable: legacy vs fused validation report.
 *
 * Runs the synthetic scenario set through three modes (v1 legacy, v2 legacy,
 * v2 fused with synthetic truth-derived evidence), scores every static
 * manifest fixture once (engine-agnostic harness sanity), measures the PU /
 * wall-time / heap cost of the S1+DEM evidence plan, and writes
 * validation/reports/phase6-legacy-vs-fused.md with per-class P/R/F1,
 * confusion matrices, deltas and the screenshot manifest.
 *
 * Requires no network: scenario evidence is synthesized from the truth
 * grids (validation/scenarios.ts), fixtures are static GeoJSON.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  aggregateConfusion,
  binaryChange,
  computeMetrics,
  f1From,
  macroF1,
  overallAccuracy,
  validateCase,
  REF_CLASSES,
  type CaseReport,
  type ClassMetrics,
  type GeoJsonFeatureCollection,
  type ValidationCase,
} from "../validation/engine";
import { buildScenarios } from "../validation/scenarios";
import { prepareCompare, type RunCompareInput } from "../lib/analysis/process";
import type { CompareRules } from "../lib/analysis/config";
import type { CompareEngine } from "../lib/analysis/types";

interface Mode {
  id: string;
  label: string;
  engine: CompareEngine;
  rules?: CompareRules;
  note: string;
}

const MODES: Mode[] = [
  {
    id: "v1-legacy",
    label: "v1 (legacy)",
    engine: "v1",
    note: "Shipped product legacy — CHANGE_ENGINE=v1 default, single-date inputs",
  },
  {
    id: "v2-legacy",
    label: "v2 (legacy)",
    engine: "v2",
    rules: "legacy",
    note: "v2 composite engine with legacy rules (engine isolation control)",
  },
  {
    id: "v2-fused",
    label: "v2 (fused)",
    engine: "v2",
    rules: "fused",
    note: "Shipped default — CHANGE_RULES=fused with synthetic truth-derived evidence",
  },
];

const TARGET_PX = 400;
const REPS = 3;

const SCENARIOS_BBOX: [number, number, number, number] = [74.0, 26.0, 74.04, 26.04];
const TEHSIL_BBOX: [number, number, number, number] = [74.0, 26.0, 74.15, 26.15];

function pct(value: number | null, digits = 1): string {
  return value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function pp(delta: number | null): string {
  if (delta === null) return "—";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${(delta * 100).toFixed(1)} pp`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function readGeoJson(absPath: string): GeoJsonFeatureCollection {
  const raw = JSON.parse(fs.readFileSync(absPath, "utf8")) as GeoJsonFeatureCollection;
  if (raw.type !== "FeatureCollection" || !Array.isArray(raw.features)) {
    throw new Error(`${absPath}: expected a GeoJSON FeatureCollection`);
  }
  return raw;
}

function rectGeometry(bbox: [number, number, number, number]) {
  const [w, s, e, n] = bbox;
  return { type: "Polygon" as const, coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}

function puFor(
  bbox: [number, number, number, number],
  withEvidence: boolean,
): number {
  const input: RunCompareInput = {
    geometry: rectGeometry(bbox),
    dateA: "2026-05-01",
    dateB: "2026-05-20",
    areaName: "phase6-pu",
    areaLevel: "tehsil",
    areaId: "phase6-pu",
    sensitivity: "medium",
    maxPx: 1500,
    engine: "v2",
    inputMode: "composite",
    compositeWindowDays: 7,
    ...(withEvidence ? { evidencePlan: { s1WindowDays: 6, terrain: true } as const } : {}),
  };
  return prepareCompare(input).estimatedPu;
}

function f1ByClass(report: CaseReport): Map<string, number | null> {
  return new Map(report.metrics.map((m) => [m.cls, m.f1]));
}

function f1Cell(value: number | null): string {
  return value === null ? "—" : (value * 100).toFixed(1);
}

function confusionMatrixTable(confusion: number[][]): string {
  const head = `| ref \\ pred | ${REF_CLASSES.join(" | ")} |`;
  const sep = `|---|${REF_CLASSES.map(() => "---").join("|")}|`;
  const rows = confusion.map(
    (row, i) => `| **${REF_CLASSES[i]}** | ${row.map((v) => String(v)).join(" | ")} |`,
  );
  return [head, sep, ...rows].join("\n");
}

interface ModeRun {
  mode: Mode;
  cases: ValidationCase[];
  reports: CaseReport[];
  aggregate: ClassMetrics[];
  aggregateConfusion: number[][];
  aggregateMacroF1: number | null;
  aggregateChangeF1: number | null;
  aggregateAccuracy: number;
  medianMs: number;
  heapDeltaMb: number;
}

function runMode(mode: Mode): ModeRun {
  let cases: ValidationCase[] = [];
  const times: number[] = [];
  let heapDeltaMb = 0;
  const gc = (globalThis as { gc?: () => void }).gc;

  for (let rep = 0; rep < REPS; rep += 1) {
    gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    cases = buildScenarios(mode.engine, undefined, mode.rules);
    const t1 = performance.now();
    const heapAfter = process.memoryUsage().heapUsed;
    times.push(t1 - t0);
    if (rep === REPS - 1) heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);
    gc?.();
  }

  const reports = cases.map((item) => validateCase(item, TARGET_PX));
  const aggConfusion = aggregateConfusion(reports);
  const aggregate = computeMetrics(aggConfusion, 1);
  const binary = binaryChange(aggConfusion);
  return {
    mode,
    cases,
    reports,
    aggregate,
    aggregateConfusion: aggConfusion,
    aggregateMacroF1: macroF1(aggregate),
    aggregateChangeF1: binary ? f1From(binary.tp, binary.fp, binary.fn) : null,
    aggregateAccuracy: overallAccuracy(aggConfusion),
    medianMs: median(times),
    heapDeltaMb,
  };
}

function main(): void {
  const root = process.cwd();
  const outPath = path.resolve(root, "validation/reports/phase6-legacy-vs-fused.md");
  const generatedAt = new Date().toISOString();

  console.log(`phase6: running ${MODES.length} modes × ${REPS} reps × 3 scenarios…`);
  const runs = MODES.map((mode) => {
    const run = runMode(mode);
    console.log(
      `  ${run.mode.id.padEnd(10)} median=${run.medianMs.toFixed(0)}ms heapΔ=${run.heapDeltaMb.toFixed(1)}MB macroF1=${pct(run.aggregateMacroF1)} changeF1=${pct(run.aggregateChangeF1)}`,
    );
    return run;
  });

  // ---- static fixtures (engine-agnostic harness sanity) --------------------
  console.log("phase6: scoring static manifest fixtures…");
  const manifestPath = path.resolve(root, "validation/cases.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    cases: Array<{
      name: string;
      reference: string;
      prediction: string;
      note?: string;
      split?: "tune" | "holdout";
    }>;
  };
  const holdoutCount = manifest.cases.filter((c) => c.split === "holdout").length;
  const fixtureRows: string[] = [];
  for (const entry of manifest.cases) {
    const report = validateCase(
      {
        name: entry.name,
        reference: readGeoJson(path.resolve(root, entry.reference)),
        prediction: readGeoJson(path.resolve(root, entry.prediction)),
        meta: { engine: "n/a" },
      },
      TARGET_PX,
    );
    fixtureRows.push(
      `| ${entry.name} | ${entry.split ?? "tune"} | ${pct(report.overallAccuracy)} | ${pct(report.macroF1)} | ${pct(report.changeF1)} | ${entry.note ?? ""} |`,
    );
    console.log(`  fixture ${entry.name}: macroF1=${pct(report.macroF1)}`);
  }

  // ---- PU cost of the S1 + DEM evidence plan ------------------------------
  console.log("phase6: estimating PU cost…");
  const puRows: string[] = [];
  const puBoxes: Array<{ name: string; bbox: [number, number, number, number] }> = [
    { name: "Scenario grid (0.04° ≈ 400 px)", bbox: SCENARIOS_BBOX },
    { name: "Tehsil-size AOI (0.15° ≈ 1500 px cap)", bbox: TEHSIL_BBOX },
  ];
  for (const box of puBoxes) {
    const base = puFor(box.bbox, false);
    const fused = puFor(box.bbox, true);
    const delta = Math.round((fused - base) * 100) / 100;
    const pctAdd = base > 0 ? ((fused - base) / base) * 100 : 0;
    puRows.push(
      `| ${box.name} | ${base.toFixed(2)} | ${fused.toFixed(2)} | +${delta.toFixed(2)} | +${pctAdd.toFixed(0)}% |`,
    );
  }

  // ---- assemble the report ------------------------------------------------
  const lines: string[] = [];
  lines.push("# Phase 6 — legacy vs fused validation");
  lines.push("");
  lines.push(`- Generated: ${generatedAt}`);
  lines.push("- Branch: `feat/accuracy-sar-context`");
  lines.push(
    `- Scenarios: 3 synthetic specs × ${MODES.length} modes × ${REPS} reps (engine wall time), grid long side ${TARGET_PX} px`,
  );
  lines.push(
    `- Fixtures: ${manifest.cases.length} static manifest case(s) (hold-out entries: ${holdoutCount}${holdoutCount === 0 ? " — none marked `split: holdout` yet" : ""})`,
  );
  lines.push(
    "- Fused evidence in this harness is **synthetic and truth-derived** (validation/scenarios.ts): the prior is the A-side land-cover truth, SAR water masks mirror the truth transitions, terrain is flat. Gates therefore preserve truth classes **by construction** — this report measures gate correctness / no-regression plus PU, runtime and memory cost. Real-world accuracy gains need human-drawn QGIS references (none exist yet; see validation/README.md).",
  );
  lines.push("");

  lines.push("## Modes");
  lines.push("");
  lines.push("| Mode | Definition |");
  lines.push("|---|---|");
  for (const mode of MODES) {
    lines.push(`| ${mode.label} | ${mode.note} |`);
  }
  lines.push("");

  lines.push("## Aggregate per-class P/R/F1 (summed confusion over the 3 scenarios)");
  lines.push("");
  lines.push(
    "| Class | v1 leg P | v1 leg R | v1 leg F1 | v2 leg P | v2 leg R | v2 leg F1 | v2 fused P | v2 fused R | v2 fused F1 | Δ F1 fused−v2 leg | Δ F1 fused−v1 leg |",
  );
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  const [v1, v2l, v2f] = runs;
  for (let i = 0; i < REF_CLASSES.length; i += 1) {
    const a = v1.aggregate[i];
    const b = v2l.aggregate[i];
    const c = v2f.aggregate[i];
    const d1 = c.f1 !== null && b.f1 !== null ? c.f1 - b.f1 : null;
    const d2 = c.f1 !== null && a.f1 !== null ? c.f1 - a.f1 : null;
    lines.push(
      `| ${REF_CLASSES[i]} | ${pct(a.precision)} | ${pct(a.recall)} | ${pct(a.f1)} | ${pct(b.precision)} | ${pct(b.recall)} | ${pct(b.f1)} | ${pct(c.precision)} | ${pct(c.recall)} | ${pct(c.f1)} | ${pp(d1)} | ${pp(d2)} |`,
    );
  }
  lines.push("");

  lines.push("## Headlines (aggregate)");
  lines.push("");
  lines.push("| Mode | Overall accuracy | Macro F1 (support > 0) | Change F1 | Engine wall time (median of 3) | Heap Δ during build |");
  lines.push("|---|---|---|---|---|---|");
  for (const run of runs) {
    lines.push(
      `| ${run.mode.label} | ${pct(run.aggregateAccuracy)} | ${pct(run.aggregateMacroF1)} | ${pct(run.aggregateChangeF1)} | ${run.medianMs.toFixed(0)} ms | ${run.heapDeltaMb.toFixed(1)} MB |`,
    );
  }
  lines.push("");
  lines.push(
    `> Wall time/heap measured around \`buildScenarios\` (truth synthesis + classify → denoise → MMU → vectorize) with \`node --expose-gc\`; heap Δ is post-build minus pre-build \`heapUsed\` after a forced GC${typeof (globalThis as { gc?: () => void }).gc === "function" ? "" : " — **not** run with --expose-gc, numbers are indicative only"}.`,
  );
  lines.push("");

  lines.push("## Per-scenario F1 by class (%)");
  lines.push("");
  lines.push(
    `| Scenario | Mode | ${REF_CLASSES.join(" | ")} | macroF1 |`,
  );
  lines.push(`|---|---|${REF_CLASSES.map(() => "---").join("|")}|---|`);
  for (const run of runs) {
    for (const report of run.reports) {
      const f1s = f1ByClass(report);
      const cells = REF_CLASSES.map((cls) => f1Cell(f1s.get(cls) ?? null)).join(" | ");
      lines.push(`| ${report.name} | ${run.mode.label} | ${cells} | ${f1Cell(report.macroF1)} |`);
    }
  }
  lines.push("");

  for (const run of runs) {
    lines.push(`## Confusion (aggregate) — ${run.mode.label}`);
    lines.push("");
    lines.push(confusionMatrixTable(run.aggregateConfusion));
    lines.push("");
  }

  lines.push("## Static fixtures (engine-agnostic harness sanity)");
  lines.push("");
  lines.push(
    "The three manifest fixtures are fixed prediction GeoJSONs — identical under every rule mode, so they are scored once as a harness sanity check (not as a legacy/fused comparison).",
  );
  lines.push("");
  lines.push("| Case | Split | Overall accuracy | Macro F1 | Change F1 | Note |");
  lines.push("|---|---|---|---|---|---|");
  lines.push(...fixtureRows);
  lines.push("");

  lines.push("## Cost of S1 + DEM evidence (v2 composite, window 7)");
  lines.push("");
  lines.push(
    "`prepareCompare` optical base vs base + two S1 renders (`S1_WINDOW_DAYS=6`) + one DEM render — the same cost model the API uses for `PER_ANALYSIS_PU_LIMIT`.",
  );
  lines.push("");
  lines.push("| AOI | Optical base PU | +S1+DEM PU | Δ PU | Δ % |");
  lines.push("|---|---|---|---|---|");
  lines.push(...puRows);
  lines.push("");

  lines.push("## Screenshots (live CDSE, dev server `CHANGE_RULES`)");
  lines.push("");
  lines.push(
    "Captured by `scripts/phase6-sites.browser.cjs` against `next dev` — once with `CHANGE_RULES=legacy` (v1 product legacy) and once with `CHANGE_RULES=fused` (v2 + live S1/WorldCover/DEM evidence), three tehsils each:",
  );
  lines.push("");
  lines.push("| Tehsil (district) | legacy | fused | method card (legacy) | method card (fused) |");
  lines.push("|---|---|---|---|---|");
  for (const [tehsil, district] of [
    ["phalodi", "Jodhpur"],
    ["sanganer", "Jaipur"],
    ["sangod", "Kota"],
  ]) {
    lines.push(
      `| ${tehsil} (${district}) | docs/screenshots/phase6-${tehsil}-legacy.png | docs/screenshots/phase6-${tehsil}-fused.png | docs/screenshots/phase6-${tehsil}-legacy-method.png | docs/screenshots/phase6-${tehsil}-fused-method.png |`,
    );
  }
  lines.push("");

  lines.push("## Interpretation");
  lines.push("");
  const dMacroV2 = v2f.aggregateMacroF1 !== null && v2l.aggregateMacroF1 !== null
    ? v2f.aggregateMacroF1 - v2l.aggregateMacroF1
    : null;
  const dMacroV1 = v2f.aggregateMacroF1 !== null && v1.aggregateMacroF1 !== null
    ? v2f.aggregateMacroF1 - v1.aggregateMacroF1
    : null;
  lines.push(
    `- **No-regression:** fused aggregate macro F1 ${pct(v2f.aggregateMacroF1)} vs v2-legacy ${pct(v2l.aggregateMacroF1)} (${pp(dMacroV2)}) and vs v1-legacy ${pct(v1.aggregateMacroF1)} (${pp(dMacroV1)}) — truth-derived evidence must not move classes; any delta comes only from confidence-aware MMU / sub-label scoring differences.`,
  );
  lines.push(
    `- **bare_agri:** no current reference set carries bare-agri truth (rows show "—"); the sub-label matcher in \`validation/engine.ts\` now accepts the engine's full text ("Bare soil on cropland (likely harvest / tillage)") plus the \`bare_agri\`/\`agri_bare\` aliases — covered by \`scripts/validation.test.ts\`.`,
  );
  lines.push(
    `- **Evidence cost:** +S1+DEM adds the Δ PU shown above (roughly two S1 renders + one DEM render on top of the optical pair); WorldCover prior is a free COG read. Live fetch wall time rides the existing CDSE Process API — no new service.`,
  );
  lines.push(
    "- **What this cannot show yet:** precision gains on real built-up/water events (Phase 0 baselines: water_gain 0% precision, builtup_increase 0% precision on the first fixture set). Those need human-drawn references over real scenes — the next validation input, not a code change.",
  );
  lines.push("");
  lines.push("## Reproduce");
  lines.push("");
  lines.push("```");
  lines.push("npm run phase6                     # this report");
  lines.push("npm run validate -- --scenarios --engine v1");
  lines.push("npm run validate -- --scenarios --engine v2");
  lines.push("npm run validate -- --scenarios --rules fused   # per-mode detail reports");
  lines.push("```");
  lines.push("");

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`phase6: report → ${path.relative(root, outPath)}`);
}

main();
