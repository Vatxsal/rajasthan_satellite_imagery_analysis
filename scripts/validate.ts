/**
 * npm run validate — reference vs engine output validation harness.
 *
 * Usage:
 *   npm run validate                       # all TUNE cases in validation/cases.json
 *   npm run validate -- --holdout          # hold-out cases only (never used for tuning)
 *   npm run validate -- --case circle-partial
 *   npm run validate -- --engine v1 --px 512 --out validation/reports/custom.md
 *   npm run validate -- --scenarios --engine v2
 *
 * Loads reference polygons (QGIS-drawn, see validation/README.md) and the
 * engine's GeoJSON output for the same area/dates, then reports per-class
 * precision, recall, F1, confusion matrix and area error.
 *
 * With --scenarios (Phase 4) the manifest is ignored: synthetic A/B rasters
 * with known ground truth run through the REAL production pipeline
 * (lib/analysis/process.ts) and the resulting patches are scored with the
 * same metrics — `--engine v1|v2` selects which engine executes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  renderMarkdownReport,
  validateCase,
  type CaseReport,
  type GeoJsonFeatureCollection,
  type ValidationCase,
} from "../validation/engine";
import { buildScenarios } from "../validation/scenarios";
import type { CompareEngine } from "../lib/analysis/types";

interface CaseEntry {
  name: string;
  reference: string;
  prediction: string;
  dateA?: string;
  dateB?: string;
  engine?: string;
  /** "tune" (default) | "holdout" — hold-out cases never run unless --holdout. */
  split?: "tune" | "holdout";
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function readGeoJson(absPath: string): GeoJsonFeatureCollection {
  const raw = JSON.parse(fs.readFileSync(absPath, "utf8")) as GeoJsonFeatureCollection;
  if (raw.type !== "FeatureCollection" || !Array.isArray(raw.features)) {
    throw new Error(`${absPath}: expected a GeoJSON FeatureCollection`);
  }
  return raw;
}

function main(): void {
  const args = process.argv.slice(2);
  const root = process.cwd();
  const manifestPath = path.resolve(root, "validation/cases.json");
  const engine = (argValue(args, "--engine") ?? "v1") as CompareEngine;
  const targetPx = Number(argValue(args, "--px") ?? "400");
  const only = argValue(args, "--case");
  const scenarios = args.includes("--scenarios");
  const holdout = args.includes("--holdout");
  const outPath = path.resolve(
    root,
    argValue(args, "--out") ??
      `validation/reports/${engine === "v1" ? "v1-baseline" : engine}${scenarios ? "-scenarios" : ""}${holdout ? "-holdout" : ""}.md`,
  );

  let entries: CaseEntry[] = [];
  if (!scenarios) {
    if (!fs.existsSync(manifestPath)) {
      console.error(`missing manifest: ${manifestPath}`);
      process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { cases: CaseEntry[] };
    // Split gate: default run = tune cases only; --holdout = hold-out only.
    // Hold-out cases are NEVER part of the default run (used for final scoring).
    entries = manifest.cases.filter((c) => {
      const isHoldout = c.split === "holdout";
      if (holdout) return isHoldout;
      return !isHoldout;
    });
    entries = entries.filter((c) => !only || c.name === only);
    if (entries.length === 0) {
      console.error(
        only
          ? `no case named "${only}" in ${manifestPath}${holdout ? " (holdout split)" : ""}`
          : holdout
            ? `no holdout cases in ${manifestPath} — add { "split": "holdout" } entries`
            : "no cases in manifest",
      );
      process.exit(1);
    }
  }

  const cases: ValidationCase[] = scenarios
    ? buildScenarios(engine, only)
    : entries.map((entry) => {
        const reference = readGeoJson(path.resolve(root, entry.reference));
        const prediction = readGeoJson(path.resolve(root, entry.prediction));
        return {
          name: entry.name,
          reference,
          prediction,
          meta: { dateA: entry.dateA, dateB: entry.dateB, engine: entry.engine ?? engine },
        };
      });
  if (cases.length === 0) {
    console.error(scenarios ? `no scenario named "${only}"` : "no cases to run");
    process.exit(1);
  }

  const started = Date.now();
  const reports: CaseReport[] = cases.map((item) => validateCase(item, targetPx));
  const elapsed = Date.now() - started;

  const hasRealRef =
    !scenarios &&
    entries.some((e) => !e.reference.includes("fixtures") && !e.prediction.includes("fixtures"));
  const note = scenarios
    ? "scenario fixtures — synthetic A/B rasters through the real engine pipeline (validation/scenarios.ts)"
    : hasRealRef
      ? undefined
      : "synthetic fixtures only — real QGIS references pending (see validation/README.md)";
  const markdown = renderMarkdownReport(reports, {
    engine: scenarios ? `${engine} (scenarios)` : engine,
    targetPx,
    note,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${markdown}\n`, "utf8");

  // Console summary: one line per case + aggregate headline.
  console.log(
    `engine=${engine}${scenarios ? " (scenarios)" : ""} split=${holdout ? "holdout" : "tune"} cases=${reports.length} grid=${targetPx}px in ${elapsed}ms`,
  );
  for (const r of reports) {
    console.log(
      `  ${r.name.padEnd(20)} acc=${(r.overallAccuracy * 100).toFixed(1)}% macroF1=${
        r.macroF1 === null ? "—" : (r.macroF1 * 100).toFixed(1)
      }% changeF1=${r.changeF1 === null ? "—" : (r.changeF1 * 100).toFixed(1)}% labeled=${(
        r.labeledFraction * 100
      ).toFixed(0)}%`,
    );
  }
  console.log(`report → ${path.relative(root, outPath)}`);
}

main();
