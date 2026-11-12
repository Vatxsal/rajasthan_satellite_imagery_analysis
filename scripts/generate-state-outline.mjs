/**
 * Generates public/data/state-outline.geojson — the Rajasthan outer boundary
 * (union of every district polygon). The map used to compute this union on the
 * main thread at startup: turf's union runs on polygon-clipping + big.js, and
 * the 41-district merge measured ~100s of main-thread work on a throttled
 * mobile CPU (the dominant Lighthouse TBT offender on /). Shipping the
 * precomputed result keeps that math offline; the client just fetches it.
 *
 * Re-run after data/boundaries/districts.geojson changes:
 *
 *   npm run generate:state-outline
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { area, booleanValid, featureCollection, union } from "@turf/turf";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const districtsPath = join(root, "data", "boundaries", "districts.geojson");
const outDir = join(root, "public", "data");
const outPath = join(outDir, "state-outline.geojson");

const fc = JSON.parse(readFileSync(districtsPath, "utf8"));
const features = (fc.features ?? []).filter(
  (f) => f?.geometry?.type === "Polygon" || f?.geometry?.type === "MultiPolygon",
);
if (features.length === 0) {
  throw new Error(`no polygon districts found in ${districtsPath}`);
}

// Same merge order as the old in-app buildStateOutline(): accumulate one
// district at a time so interior borders cancel and only the outer ring
// remains. Node has no jank budget, so no yielding is needed here.
let accumulated = null;
for (let i = 0; i < features.length; i++) {
  const candidate = { type: "Feature", properties: {}, geometry: features[i].geometry };
  if (!accumulated) {
    accumulated = candidate;
    continue;
  }
  try {
    const merged = union(featureCollection([accumulated, candidate]));
    if (merged) accumulated = merged;
  } catch (error) {
    console.warn(`skip "${features[i].properties?.name}": ${error.message}`);
  }
}

if (!accumulated) throw new Error("union produced no outline");
if (!booleanValid(accumulated)) {
  console.warn("warning: generated outline fails booleanValid()");
}

const json = JSON.stringify(accumulated);
mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, json);

const sourceArea = area(featureCollection(features));
const outlineArea = area(accumulated);
const delta = ((outlineArea - sourceArea) / sourceArea) * 100;
console.log(`wrote ${outPath}`);
console.log(
  `  districts: ${features.length}, type: ${accumulated.geometry.type}, ` +
    `size: ${Math.round(Buffer.byteLength(json) / 1024)} KB`,
);
console.log(
  `  area: source ${Math.round(sourceArea / 1e6)} km² → outline ` +
    `${Math.round(outlineArea / 1e6)} km² (delta ${delta.toFixed(3)}%)`,
);
