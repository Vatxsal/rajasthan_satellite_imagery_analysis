/**
 * `npm run features` — dumps per-pixel training rows for ml/train.py.
 *
 * Usage:
 *   npm run features                          → artifacts/ml/features.csv
 *   npm run features -- --out path.csv        → custom destination
 *   npm run features -- --only scenario-classes
 *
 * Columns: scenario,label + every name in ML_FEATURES (raw values; train.py
 * computes the standardisation). Output lives under gitignored artifacts/.
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { ML_FEATURES } from "../lib/analysis/model";
import { featureRows } from "../validation/scenarios";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const outPath = argValue("--out") ?? path.join("artifacts", "ml", "features.csv");
const only = argValue("--only");

mkdirSync(path.dirname(outPath), { recursive: true });
const fd = openSync(outPath, "w");

const header = ["scenario", "label", ...ML_FEATURES].join(",") + "\n";
writeSync(fd, header);

const perLabel = new Map<string, number>();
const perScenario = new Map<string, number>();
let total = 0;
let chunk: string[] = [];
const FLUSH_EVERY = 20_000;

for (const row of featureRows(only)) {
  const values = new Array<string>(ML_FEATURES.length);
  for (let k = 0; k < ML_FEATURES.length; k++) {
    values[k] = String(row.features[k]);
  }
  chunk.push(`${row.scenario},${row.label},${values.join(",")}\n`);
  perLabel.set(row.label, (perLabel.get(row.label) ?? 0) + 1);
  perScenario.set(row.scenario, (perScenario.get(row.scenario) ?? 0) + 1);
  total += 1;
  if (chunk.length >= FLUSH_EVERY) {
    writeSync(fd, chunk.join(""));
    chunk = [];
  }
}
if (chunk.length > 0) writeSync(fd, chunk.join(""));
closeSync(fd);

const labelSummary = [...perLabel.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([label, count]) => `${label}=${count}`)
  .join(" ");
const scenarioSummary = [...perScenario.entries()]
  .map(([name, count]) => `${name}=${count}`)
  .join(" ");

console.log(`features: ${total} rows → ${outPath}`);
console.log(`  columns: ${ML_FEATURES.length} + scenario + label`);
console.log(`  labels:  ${labelSummary}`);
console.log(`  by scenario: ${scenarioSummary}`);
console.log(`next: python ml/train.py --data ${outPath}`);
