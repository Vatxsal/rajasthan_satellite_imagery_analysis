/**
 * Boundary dataset validation CLI — prints the full report for the current
 * 41-district set (counts, names, geometry, tiling, area vs official,
 * legacy Census-2011 deltas, tehsil integrity). Exits non-zero on failure.
 *
 *   npm run validate:boundaries
 */
import { validateBoundaries } from "../validation/boundaries";

const result = validateBoundaries();

console.log("Boundary validation — data/boundaries");
for (const line of result.report) console.log(line);

if (result.warnings.length > 0) {
  console.log("\nwarnings:");
  for (const warning of result.warnings) console.log(`  - ${warning}`);
}

if (result.errors.length > 0) {
  console.log("\nERRORS:");
  for (const error of result.errors) console.log(`  - ${error}`);
  process.exitCode = 1;
} else {
  console.log("\nOK — all boundary checks passed.");
}
