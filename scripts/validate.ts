/**
 * npm run validate — reference vs engine output validation harness.
 *
 * Usage:
 *   npm run validate                       # all cases in validation/cases.json
 *   npm run validate -- --case circle-partial
 *   npm run validate -- --engine v1 --px 512 --out validation/reports/custom.md
 *
 * Loads reference polygons (QGIS-drawn, see validation/README.md) and the
 * engine's GeoJSON output for the same area/dates, then reports per-class
 * precision, recall, F1, confusion matrix and area error.
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

interface CaseEntry {
  name: string;
  reference: string;
  prediction: string;
  dateA?: string;
  dateB?: string;
  engine?: string;
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
  const engine = argValue(args, "--engine") ?? "v1";
  const targetPx = Number(argValue(args, "--px") ?? "400");
  const only = argValue(args, "--case");
  const outPath = path.resolve(
    root,
    argValue(args, "--out") ?? `validation/reports/${engine === "v1" ? "v1-baseline" : engine}.md`,
  );

  if (!fs.existsSync(manifestPath)) {
    console.error(`missing manifest: ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { cases: CaseEntry[] };
  const entries = manifest.cases.filter((c) => !only || c.name === only);
  if (entries.length === 0) {
    console.error(only ? `no case named "${only}" in ${manifestPath}` : "no cases in manifest");
    process.exit(1);
  }

  const cases: ValidationCase[] = entries.map((entry) => {
    const reference = readGeoJson(path.resolve(root, entry.reference));
    const prediction = readGeoJson(path.resolve(root, entry.prediction));
    return {
      name: entry.name,
      reference,
      prediction,
      meta: { dateA: entry.dateA, dateB: entry.dateB, engine: entry.engine ?? engine },
    };
  });

  const started = Date.now();
  const reports: CaseReport[] = cases.map((item) => validateCase(item, targetPx));
  const elapsed = Date.now() - started;

  const hasRealRef = entries.some(
    (e) => !e.reference.includes("fixtures") && !e.prediction.includes("fixtures"),
  );
  const note = hasRealRef
    ? undefined
    : "synthetic fixtures only — real QGIS references pending (see validation/README.md)";
  const markdown = renderMarkdownReport(reports, {
    engine,
    targetPx,
    note,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${markdown}\n`, "utf8");

  // Console summary: one line per case + aggregate headline.
  console.log(`engine=${engine} cases=${reports.length} grid=${targetPx}px in ${elapsed}ms`);
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
