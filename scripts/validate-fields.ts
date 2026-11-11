/**
 * npm run validate:fields — reference vs fields/pattern validation harness.
 *
 * Usage:
 *   npm run validate:fields                                    # all cases in validation/fields-cases.json
 *   npm run validate:fields -- --case fields-aligned           # one case
 *   npm run validate:fields -- --px 512 --tol 3                # grid size / boundary tolerance
 *   npm run validate:fields -- --out validation/reports/custom.md
 *
 * Loads reference field polygons (QGIS-drawn, see validation/README.md) and
 * our field + pattern GeoJSON for the same extent, then reports field-mask
 * IoU/precision/recall/F1, boundary MCC, per-class pattern metrics and a
 * class confusion matrix. Fully offline — never calls CDSE or Source Cooperative.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  renderFieldsMarkdownReport,
  validateFieldsCase,
  type FieldsCase,
  type FieldsCaseReport,
} from "../validation/fields";
import type { GeoJsonFeatureCollection } from "../validation/engine";

interface CaseEntry {
  name: string;
  reference: string;
  prediction: string;
  year?: number;
  note?: string;
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
  const manifestPath = path.resolve(root, "validation/fields-cases.json");
  const targetPx = Number(argValue(args, "--px") ?? "400");
  const tolerancePx = Number(argValue(args, "--tol") ?? "2");
  const only = argValue(args, "--case");
  const outPath = path.resolve(
    root,
    argValue(args, "--out") ?? "validation/reports/fields-baseline.md",
  );

  if (!Number.isFinite(targetPx) || targetPx < 64) {
    console.error(`--px must be >= 64 (got "${argValue(args, "--px")}")`);
    process.exit(1);
  }
  if (!Number.isFinite(tolerancePx) || tolerancePx < 0) {
    console.error(`--tol must be >= 0 (got "${argValue(args, "--tol")}")`);
    process.exit(1);
  }
  if (!fs.existsSync(manifestPath)) {
    console.error(`missing manifest: ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { cases: CaseEntry[] };
  let entries = manifest.cases;
  if (only) entries = entries.filter((c) => c.name === only);
  if (entries.length === 0) {
    console.error(
      only
        ? `no case named "${only}" in ${manifestPath}`
        : "no cases in manifest",
    );
    process.exit(1);
  }

  const started = Date.now();
  const reports: FieldsCaseReport[] = entries.map((entry) => {
    const item: FieldsCase = {
      name: entry.name,
      reference: readGeoJson(path.resolve(root, entry.reference)),
      prediction: readGeoJson(path.resolve(root, entry.prediction)),
      meta: { year: entry.year, note: entry.note },
    };
    return validateFieldsCase(item, targetPx, tolerancePx);
  });
  const elapsed = Date.now() - started;

  const hasRealRef = entries.some(
    (e) => !e.reference.includes("fixtures") && !e.prediction.includes("fixtures"),
  );
  const note = hasRealRef
    ? undefined
    : "synthetic fixtures only — real QGIS references pending (see validation/README.md)";
  const markdown = renderFieldsMarkdownReport(reports, {
    targetPx,
    tolerancePx,
    note,
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${markdown}\n`, "utf8");

  console.log(
    `fields cases=${reports.length} grid=${targetPx}px tol=${tolerancePx}px in ${elapsed}ms`,
  );
  for (const r of reports) {
    console.log(
      `  ${r.name.padEnd(22)} IoU=${pct(r.mask.iou)} P=${pct(r.mask.precision)} R=${pct(
        r.mask.recall,
      )} F1=${pct(r.mask.f1)} bMCC=${
        r.boundaryMcc === null ? "—" : r.boundaryMcc.toFixed(3)
      } macroF1=${pct(r.macroF1)}`,
    );
  }
  console.log(`report → ${path.relative(root, outPath)}`);
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

main();
