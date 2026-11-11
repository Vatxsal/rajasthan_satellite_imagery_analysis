import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DISTRICT_ID_ALIASES, resolveDistrictId } from "../lib/data/districtAliases";
import { TARGET_DISTRICTS, THRESHOLDS, validateBoundaries } from "../validation/boundaries";

/** 41-district boundary dataset: counts, names, geometry, tiling, area vs
 *  official 342,000 km², legacy Census-2011 deltas, tehsil integrity, plus
 *  the README/LoginHero guards that keep counts computed, not hard-coded. */

const root = process.cwd();
let cached: ReturnType<typeof validateBoundaries> | null = null;
function result(): ReturnType<typeof validateBoundaries> {
  cached ??= validateBoundaries(root);
  return cached;
}

test("all boundary checks pass (no errors)", () => {
  assert.deepEqual(result().errors, []);
});

test("districts: exactly 41 features with the target names", () => {
  const { metrics } = result();
  assert.equal(metrics.districtCount, 41);
  assert.deepEqual(metrics.districtNames, [...TARGET_DISTRICTS].sort());
  assert.equal(new Set(metrics.districtIds).size, 41);
});

test("districts: geometries valid, RFC 7946 winding, OSM/ODbL attribution", () => {
  const { metrics } = result();
  assert.equal(metrics.geometryIssues, 0);
  assert.ok(metrics.exteriorRings >= 41, `${metrics.exteriorRings} exterior rings`);
  assert.equal(metrics.districtAttributionOk, true);
});

test("tiling: overlaps, gaps and sum-vs-union within thresholds", () => {
  const { metrics } = result();
  assert.ok(
    metrics.overlapTotalKm2 <= THRESHOLDS.maxOverlapKm2,
    `overlaps ${metrics.overlapTotalKm2} km²`,
  );
  assert.ok(
    metrics.unionHoleKm2 <= THRESHOLDS.maxUnionHoleKm2,
    `gaps ${metrics.unionHoleKm2} km²`,
  );
  assert.ok(
    metrics.sumVsUnionKm2 <= THRESHOLDS.maxSumVsUnionKm2,
    `|sum-union| ${metrics.sumVsUnionKm2} km²`,
  );
});

test("area: union within ±2% of the official 342,000 km²", () => {
  const { metrics } = result();
  const lo = THRESHOLDS.areaOfficialKm2 * (1 - THRESHOLDS.areaTolerancePct / 100);
  const hi = THRESHOLDS.areaOfficialKm2 * (1 + THRESHOLDS.areaTolerancePct / 100);
  assert.ok(
    metrics.unionKm2 >= lo && metrics.unionKm2 <= hi,
    `union ${metrics.unionKm2} km² outside [${lo}, ${hi}]`,
  );
});

test("legacy: new set covers the Census-2011 state outline with per-district deltas", () => {
  const { metrics } = result();
  assert.ok(
    metrics.legacyUncoveredKm2 <= THRESHOLDS.maxLegacyUncoveredKm2,
    `uncovered ${metrics.legacyUncoveredKm2} km²`,
  );
  assert.ok(
    metrics.legacyExpansionKm2 <= THRESHOLDS.maxLegacyExpansionKm2,
    `expansion ${metrics.legacyExpansionKm2} km²`,
  );
  assert.ok(metrics.legacyMinCoverage, "legacy coverage computed");
  assert.ok(
    metrics.legacyMinCoverage.pct >= THRESHOLDS.minLegacyCoveragePct,
    `min coverage ${metrics.legacyMinCoverage.name} ${metrics.legacyMinCoverage.pct}%`,
  );
  assert.equal(metrics.legacyDeltas.length, 33);
  for (const delta of metrics.legacyDeltas) {
    assert.ok(delta.sameName, `${delta.legacy} maps to a new district`);
  }
});

test("tehsils: 224 features, ids and geometry unchanged, parents valid", () => {
  const { metrics } = result();
  assert.equal(metrics.tehsilCount, THRESHOLDS.expectedTehsils);
  assert.equal(metrics.tehsilsUnchanged, true);
  assert.equal(metrics.tehsilParentsValid, true);
  assert.equal(Object.keys(metrics.tehsilsPerDistrict).length, 41);
});

test("district id aliases resolve to existing ids", () => {
  const ids = new Set(result().metrics.districtIds);
  for (const [key, value] of Object.entries(DISTRICT_ID_ALIASES)) {
    assert.ok(ids.has(value), `alias ${key} → ${value} is not a district id`);
    assert.ok(!ids.has(key), `alias key ${key} collides with a real district id`);
  }
  assert.equal(resolveDistrictId("d-chittorgarh"), "d-chittaurgarh");
  assert.equal(resolveDistrictId("d-ajmer"), "d-ajmer");
});

test("login hero has no hard-coded district/tehsil counts", () => {
  const hero = readFileSync(join(root, "components", "login", "LoginHero.tsx"), "utf8");
  assert.ok(!/33 districts/.test(hero), "no hard-coded district count");
  assert.ok(!/\b224\b/.test(hero), "no hard-coded tehsil count");
  assert.ok(hero.includes("districtCount"), "districtCount prop used");
  assert.ok(hero.includes("tehsilCount"), "tehsilCount prop used");
});

test("README documents the computed district/tehsil counts", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const { metrics } = result();
  assert.ok(
    readme.includes(`${metrics.districtCount} districts`),
    `README must mention "${metrics.districtCount} districts"`,
  );
  assert.ok(
    readme.includes(`${metrics.tehsilCount} tehsils`),
    `README must mention "${metrics.tehsilCount} tehsils"`,
  );
});

test("data/boundaries/README.md documents sources and licences", () => {
  const doc = readFileSync(join(root, "data", "boundaries", "README.md"), "utf8");
  assert.match(doc, /OpenStreetMap/);
  assert.match(doc, /ODbL/);
  assert.match(doc, /Datameet/);
  assert.match(doc, /Census/);
});
