import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  area,
  bbox as turfBbox,
  booleanValid,
  difference,
  feature,
  featureCollection,
  intersect,
  union,
} from "@turf/turf";

/** Canonical names of the current 41 districts (28–30 Dec 2024 reorganisation). */
export const TARGET_DISTRICTS = [
  "Ajmer",
  "Alwar",
  "Balotra",
  "Banswara",
  "Baran",
  "Barmer",
  "Beawar",
  "Bharatpur",
  "Bhilwara",
  "Bikaner",
  "Bundi",
  "Chittorgarh",
  "Churu",
  "Dausa",
  "Deeg",
  "Dholpur",
  "Didwana-Kuchaman",
  "Dungarpur",
  "Hanumangarh",
  "Jaipur",
  "Jaisalmer",
  "Jalore",
  "Jhalawar",
  "Jhunjhunu",
  "Jodhpur",
  "Karauli",
  "Khairthal-Tijara",
  "Kota",
  "Kotputli-Behror",
  "Nagaur",
  "Pali",
  "Phalodi",
  "Pratapgarh",
  "Rajsamand",
  "Salumber",
  "Sawai Madhopur",
  "Sikar",
  "Sirohi",
  "Sri Ganganagar",
  "Tonk",
  "Udaipur",
] as const;

/** Legacy (Census-2011 file) district name → canonical target name. */
export const LEGACY_NAME_ALIASES: Record<string, string> = {
  Chittaurgarh: "Chittorgarh",
  Dhaulpur: "Dholpur",
  Ganganagar: "Sri Ganganagar",
  Jalor: "Jalore",
};

/**
 * Pass/fail bounds. Baselines measured on the shipped data (2026-11-11):
 * overlaps 0 km², union holes 3.84 km², sum−union 0.10 km², union area
 * 342,838 km² (+0.25% vs official), legacy uncovered 401 km² / expansion
 * 412 km², min legacy coverage 99.31% (Jhalawar).
 */
export const THRESHOLDS = {
  areaOfficialKm2: 342_000,
  areaTolerancePct: 2,
  maxOverlapKm2: 0.5,
  maxUnionHoleKm2: 10,
  maxSumVsUnionKm2: 10,
  maxLegacyUncoveredKm2: 1_000,
  maxLegacyExpansionKm2: 1_000,
  minLegacyCoveragePct: 98.5,
  expectedTehsils: 224,
} as const;

const KM2 = 1e-6;

interface BoundaryDoc {
  type: string;
  metadata?: Record<string, unknown>;
  features: GeoJSON.Feature[];
}

export interface LegacyDelta {
  legacy: string;
  legacyKm2: number;
  sameName: string | null;
  sameNameKm2: number | null;
  deltaPct: number | null;
  covers: Array<[string, number]>;
}

export interface BoundaryMetrics {
  districtCount: number;
  districtNames: string[];
  districtIds: string[];
  geometryIssues: number;
  exteriorRings: number;
  districtAttributionOk: boolean;
  overlapPairCount: number;
  overlapTotalKm2: number;
  overlapMaxKm2: number;
  overlapWorst: string | null;
  unionHoleCount: number;
  unionHoleKm2: number;
  featureSumKm2: number;
  unionKm2: number;
  sumVsUnionKm2: number;
  areaDeltaPct: number;
  legacyUnionKm2: number;
  legacyUncoveredKm2: number;
  legacyExpansionKm2: number;
  legacyMinCoverage: { name: string; pct: number } | null;
  legacyDeltas: LegacyDelta[];
  tehsilCount: number;
  tehsilsUnchanged: boolean;
  tehsilParentsValid: boolean;
  tehsilsPerDistrict: Record<string, number>;
}

export interface BoundaryValidation {
  errors: string[];
  warnings: string[];
  metrics: BoundaryMetrics;
  report: string[];
}

export function loadBoundaryDocs(root: string = process.cwd()): {
  districts: BoundaryDoc;
  tehsils: BoundaryDoc;
  legacyDistricts: BoundaryDoc;
  legacyTehsils: BoundaryDoc;
} {
  const read = (relative: string): BoundaryDoc =>
    JSON.parse(readFileSync(join(root, relative), "utf8")) as BoundaryDoc;
  return {
    districts: read("data/boundaries/districts.geojson"),
    tehsils: read("data/boundaries/tehsils.geojson"),
    legacyDistricts: read("data/boundaries/legacy/districts-census-2011-33.geojson"),
    legacyTehsils: read("data/boundaries/legacy/tehsils-census-2011-224.geojson"),
  };
}

function geomOf(f: GeoJSON.Feature): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  const g = f.geometry;
  if (!g) throw new Error("feature without geometry");
  if (g.type !== "Polygon" && g.type !== "MultiPolygon") {
    throw new Error(`unsupported geometry type ${g.type}`);
  }
  return g;
}

function polygonParts(geometry: GeoJSON.Geometry): GeoJSON.Position[][][] {
  if (geometry.type === "Polygon") return [geometry.coordinates];
  if (geometry.type === "MultiPolygon") return geometry.coordinates;
  throw new Error(`unsupported geometry type ${geometry.type}`);
}

function signedRingArea(ring: GeoJSON.Position[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  }
  return sum / 2;
}

function fmt(n: number, digits = 0): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function ringClosureOk(ring: GeoJSON.Position[]): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return false;
  return first[0] === last[0] && first[1] === last[1];
}

function coordsFinite(geometry: GeoJSON.Geometry): boolean {
  for (const part of polygonParts(geometry)) {
    for (const ring of part) {
      for (const pos of ring) {
        if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) return false;
      }
    }
  }
  return true;
}

export function validateBoundaries(root: string = process.cwd()): BoundaryValidation {
  const docs = loadBoundaryDocs(root);
  const errors: string[] = [];
  const warnings: string[] = [];
  const report: string[] = [];

  /* ---------------------------------------------------------- districts */
  const dFeatures = docs.districts.features;
  const names = dFeatures.map((f) => String(f.properties?.name ?? ""));
  const ids = dFeatures.map((f) => String(f.properties?.id ?? ""));
  const target = [...TARGET_DISTRICTS];

  if (dFeatures.length !== 41) {
    errors.push(`districts: expected 41 features, found ${dFeatures.length}`);
  }
  const missing = target.filter((n) => !names.includes(n));
  const extra = names.filter((n) => !(target as readonly string[]).includes(n));
  if (missing.length) errors.push(`districts: missing target names: ${missing.join(", ")}`);
  if (extra.length) errors.push(`districts: unexpected names: ${extra.join(", ")}`);

  const seenIds = new Set<string>();
  let attributionOk = true;
  for (const f of dFeatures) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const id = String(props.id ?? "");
    const name = String(props.name ?? "?");
    if (seenIds.has(id)) errors.push(`districts: duplicate id ${id}`);
    seenIds.add(id);
    if (!id.startsWith("d-")) errors.push(`districts: "${name}" has id "${id}" (expected d-*)`);
    if (props.source !== "OpenStreetMap") {
      attributionOk = false;
      errors.push(`districts: "${name}" source is ${JSON.stringify(props.source)}, expected "OpenStreetMap"`);
    }
    if (props.license !== "ODbL-1.0") {
      attributionOk = false;
      errors.push(`districts: "${name}" license is ${JSON.stringify(props.license)}, expected "ODbL-1.0"`);
    }
    if (!props.retrievedAt) {
      attributionOk = false;
      errors.push(`districts: "${name}" missing retrievedAt`);
    }
  }
  const meta = docs.districts.metadata ?? {};
  if (!String(meta.source ?? "").includes("OpenStreetMap") || meta.license !== "ODbL-1.0") {
    attributionOk = false;
    errors.push("districts: collection metadata missing OpenStreetMap source / ODbL-1.0 licence");
  }

  /* ------------------------------------------------------ geometry checks */
  let geometryIssues = 0;
  let exteriorRings = 0;
  for (const f of dFeatures) {
    const name = String(f.properties?.name ?? "?");
    let geometry: GeoJSON.Geometry;
    try {
      geometry = geomOf(f);
    } catch {
      geometryIssues += 1;
      errors.push(`districts: "${name}" has no geometry`);
      continue;
    }
    if (!coordsFinite(geometry)) {
      geometryIssues += 1;
      errors.push(`districts: "${name}" has non-finite coordinates`);
      continue;
    }
    try {
      if (!booleanValid(feature(geometry) as Parameters<typeof booleanValid>[0])) {
        geometryIssues += 1;
        errors.push(`districts: "${name}" geometry is invalid or self-intersecting`);
      }
    } catch (error) {
      geometryIssues += 1;
      errors.push(`districts: "${name}" validity check failed: ${String(error)}`);
    }
    for (const poly of polygonParts(geometry)) {
      poly.forEach((ring, ringIndex) => {
        if (ring.length < 4 || !ringClosureOk(ring)) {
          geometryIssues += 1;
          errors.push(`districts: "${name}" ring ${ringIndex} is not closed or has < 4 positions`);
          return;
        }
        const signed = signedRingArea(ring);
        if (ringIndex === 0) {
          exteriorRings += 1;
          if (signed <= 0) {
            geometryIssues += 1;
            errors.push(`districts: "${name}" exterior ring is not counter-clockwise (RFC 7946)`);
          }
        } else if (signed >= 0) {
          geometryIssues += 1;
          errors.push(`districts: "${name}" hole ring ${ringIndex} is not clockwise (RFC 7946)`);
        }
      });
    }
  }

  /* ------------------------------------------------------------- tiling */
  const geoms = dFeatures.map(geomOf);
  const boxes = geoms.map((g) => turfBbox(feature(g)));
  const overlaps: Array<[string, string, number]> = [];
  for (let i = 0; i < geoms.length; i += 1) {
    const bi = boxes[i]!;
    for (let j = i + 1; j < geoms.length; j += 1) {
      const bj = boxes[j]!;
      if (bi[0]! > bj[2]! || bj[0]! > bi[2]! || bi[1]! > bj[3]! || bj[1]! > bi[3]!) continue;
      try {
        const ix = intersect(featureCollection([feature(geoms[i]!), feature(geoms[j]!)]));
        if (!ix) continue;
        const km2 = area(ix) * KM2;
        if (km2 > 1e-6) overlaps.push([names[i]!, names[j]!, km2]);
      } catch (error) {
        errors.push(`districts: intersect ${names[i]}/${names[j]} failed: ${String(error)}`);
      }
    }
  }
  overlaps.sort((a, b) => b[2] - a[2]);
  const overlapTotalKm2 = overlaps.reduce((sum, o) => sum + o[2], 0);
  const overlapMaxKm2 = overlaps[0]?.[2] ?? 0;
  const overlapWorst = overlaps[0] ? `${overlaps[0][0]} × ${overlaps[0][1]}` : null;
  if (overlapTotalKm2 > THRESHOLDS.maxOverlapKm2) {
    errors.push(
      `tiling: pairwise overlaps total ${fmt(overlapTotalKm2, 3)} km² ` +
        `(max ${fmt(overlapMaxKm2, 3)} km² ${overlapWorst ?? ""}) > ${THRESHOLDS.maxOverlapKm2} km²`,
    );
  } else if (overlaps.length > 0) {
    warnings.push(
      `tiling: ${overlaps.length} sliver overlap(s) totalling ${fmt(overlapTotalKm2, 3)} km² (within threshold)`,
    );
  }

  const featureSumKm2 = geoms.reduce((sum, g) => sum + area(feature(g)) * KM2, 0);
  const united = union(featureCollection(geoms.map((g) => feature(g))));
  let unionKm2 = 0;
  let unionHoleCount = 0;
  let unionHoleKm2 = 0;
  let sumVsUnionKm2 = 0;
  let areaDeltaPct = 0;
  if (!united) {
    errors.push("tiling: union of the 41 districts failed");
  } else {
    unionKm2 = area(united) * KM2;
    for (const poly of polygonParts(united.geometry)) {
      for (const ring of poly.slice(1)) {
        unionHoleCount += 1;
        unionHoleKm2 += area(feature({ type: "Polygon", coordinates: [ring] })) * KM2;
      }
    }
    sumVsUnionKm2 = Math.abs(featureSumKm2 - unionKm2);
    areaDeltaPct = ((unionKm2 - THRESHOLDS.areaOfficialKm2) / THRESHOLDS.areaOfficialKm2) * 100;
    const lo = THRESHOLDS.areaOfficialKm2 * (1 - THRESHOLDS.areaTolerancePct / 100);
    const hi = THRESHOLDS.areaOfficialKm2 * (1 + THRESHOLDS.areaTolerancePct / 100);
    if (unionKm2 < lo || unionKm2 > hi) {
      errors.push(
        `area: union ${fmt(unionKm2)} km² outside ±${THRESHOLDS.areaTolerancePct}% of ` +
          `${fmt(THRESHOLDS.areaOfficialKm2)} km² [${fmt(lo)}–${fmt(hi)}]`,
      );
    }
    if (unionHoleKm2 > THRESHOLDS.maxUnionHoleKm2) {
      errors.push(`tiling: ${unionHoleCount} gap ring(s) totalling ${fmt(unionHoleKm2, 3)} km² > ${THRESHOLDS.maxUnionHoleKm2} km²`);
    } else if (unionHoleCount > 0) {
      warnings.push(`tiling: ${unionHoleCount} gap ring(s) totalling ${fmt(unionHoleKm2, 3)} km² (within threshold)`);
    }
    if (sumVsUnionKm2 > THRESHOLDS.maxSumVsUnionKm2) {
      errors.push(`tiling: |feature sum − union| = ${fmt(sumVsUnionKm2, 3)} km² > ${THRESHOLDS.maxSumVsUnionKm2} km²`);
    }
  }

  /* ------------------------------------------------------ legacy compare */
  const legacyFeatures = docs.legacyDistricts.features;
  const legacyUnited = union(featureCollection(legacyFeatures.map((f) => feature(geomOf(f)))));
  let legacyUnionKm2 = 0;
  let legacyUncoveredKm2 = 0;
  let legacyExpansionKm2 = 0;
  if (!legacyUnited || !united) {
    errors.push("legacy: union comparison unavailable (union failed)");
  } else {
    legacyUnionKm2 = area(legacyUnited) * KM2;
    try {
      const uncovered = difference(featureCollection([legacyUnited, united]));
      legacyUncoveredKm2 = uncovered ? area(uncovered) * KM2 : 0;
    } catch (error) {
      errors.push(`legacy: uncovered difference failed: ${String(error)}`);
    }
    try {
      const expansion = difference(featureCollection([united, legacyUnited]));
      legacyExpansionKm2 = expansion ? area(expansion) * KM2 : 0;
    } catch (error) {
      errors.push(`legacy: expansion difference failed: ${String(error)}`);
    }
    if (legacyUncoveredKm2 > THRESHOLDS.maxLegacyUncoveredKm2) {
      errors.push(
        `legacy: ${fmt(legacyUncoveredKm2)} km² of the Census-2011 state outline is not covered by the new set > ${THRESHOLDS.maxLegacyUncoveredKm2} km²`,
      );
    }
    if (legacyExpansionKm2 > THRESHOLDS.maxLegacyExpansionKm2) {
      errors.push(
        `legacy: new set extends ${fmt(legacyExpansionKm2)} km² beyond the Census-2011 outline > ${THRESHOLDS.maxLegacyExpansionKm2} km²`,
      );
    }
  }

  const legacyDeltas: LegacyDelta[] = [];
  let legacyMinCoverage: { name: string; pct: number } | null = null;
  for (const lf of legacyFeatures) {
    const legacyName = String(lf.properties?.name ?? "?");
    const legacyGeom = geomOf(lf);
    const legacyKm2 = area(feature(legacyGeom)) * KM2;
    const lb = turfBbox(feature(legacyGeom));
    let covered = 0;
    const covers: Array<[string, number]> = [];
    for (let i = 0; i < geoms.length; i += 1) {
      const b = boxes[i]!;
      if (lb[0]! > b[2]! || b[0]! > lb[2]! || lb[1]! > b[3]! || b[1]! > lb[3]!) continue;
      try {
        const ix = intersect(featureCollection([feature(legacyGeom), feature(geoms[i]!)]));
        if (!ix) continue;
        const km2 = area(ix) * KM2;
        covered += km2;
        if (legacyKm2 > 0 && km2 / legacyKm2 >= 0.01) covers.push([names[i]!, (100 * km2) / legacyKm2]);
      } catch {
        /* pair skipped — global intersect failures already surfaced above */
      }
    }
    const pct = legacyKm2 > 0 ? (100 * covered) / legacyKm2 : 0;
    if (!legacyMinCoverage || pct < legacyMinCoverage.pct) legacyMinCoverage = { name: legacyName, pct };
    if (pct < THRESHOLDS.minLegacyCoveragePct) {
      errors.push(
        `legacy: ${legacyName} only ${fmt(pct, 2)}% covered by the new set (< ${THRESHOLDS.minLegacyCoveragePct}%)`,
      );
    }
    const canonical = LEGACY_NAME_ALIASES[legacyName] ?? legacyName;
    const sameIndex = names.indexOf(canonical);
    const sameNameKm2 = sameIndex >= 0 ? area(feature(geoms[sameIndex]!)) * KM2 : null;
    if (sameIndex < 0) {
      errors.push(`legacy: ${legacyName} maps to "${canonical}" which is not in the new set`);
    }
    legacyDeltas.push({
      legacy: legacyName,
      legacyKm2,
      sameName: sameIndex >= 0 ? canonical : null,
      sameNameKm2,
      deltaPct: sameNameKm2 !== null && legacyKm2 > 0 ? ((sameNameKm2 - legacyKm2) / legacyKm2) * 100 : null,
      covers: covers.sort((a, b) => b[1] - a[1]).slice(0, 4),
    });
  }

  /* ------------------------------------------------------------- tehsils */
  const tFeatures = docs.tehsils.features;
  const legacyTehsilFeatures = docs.legacyTehsils.features;
  const tehsilCount = tFeatures.length;
  if (tehsilCount !== THRESHOLDS.expectedTehsils) {
    errors.push(`tehsils: expected ${THRESHOLDS.expectedTehsils} features, found ${tehsilCount}`);
  }
  if (tehsilCount !== legacyTehsilFeatures.length) {
    errors.push(`tehsils: ${tehsilCount} features vs ${legacyTehsilFeatures.length} in the legacy snapshot`);
  }

  const currentIds = tFeatures.map((f) => String(f.properties?.id ?? "")).sort();
  const legacyIds = legacyTehsilFeatures.map((f) => String(f.properties?.id ?? "")).sort();
  const idsMatch = currentIds.length === legacyIds.length && currentIds.every((id, i) => id === legacyIds[i]);
  let tehsilsUnchanged = idsMatch;
  if (!idsMatch) errors.push("tehsils: id set differs from the legacy snapshot");

  if (tFeatures.length === legacyTehsilFeatures.length) {
    for (let i = 0; i < tFeatures.length; i += 1) {
      const cur = tFeatures[i]!;
      const old = legacyTehsilFeatures[i]!;
      const curId = String(cur.properties?.id ?? "");
      const sameId = curId === String(old.properties?.id ?? "");
      const sameName = String(cur.properties?.name ?? "") === String(old.properties?.name ?? "");
      const sameGeometry = JSON.stringify(cur.geometry) === JSON.stringify(old.geometry);
      if (!sameId || !sameName || !sameGeometry) {
        tehsilsUnchanged = false;
        errors.push(`tehsils: feature ${i} (${curId}) id/name/geometry differs from the legacy snapshot`);
        break;
      }
    }
  }

  const districtIdSet = new Set(ids);
  let tehsilParentsValid = true;
  const tehsilsPerDistrict: Record<string, number> = {};
  for (const f of tFeatures) {
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const tId = String(props.id ?? "?");
    const districtId = String(props.districtId ?? "");
    const parentId = String(props.parentId ?? "");
    if (!districtIdSet.has(districtId) || !districtIdSet.has(parentId) || districtId !== parentId) {
      tehsilParentsValid = false;
      errors.push(`tehsils: ${tId} has districtId/parentId ${districtId}/${parentId} (invalid or mismatched)`);
      continue;
    }
    tehsilsPerDistrict[districtId] = (tehsilsPerDistrict[districtId] ?? 0) + 1;
  }
  const uncoveredDistricts = ids.filter((id) => !tehsilsPerDistrict[id]);
  if (uncoveredDistricts.length > 0) {
    errors.push(`tehsils: districts with no tehsil: ${uncoveredDistricts.join(", ")}`);
  }
  const tMeta = docs.tehsils.metadata ?? {};
  if (tMeta.count !== 224 || !tMeta.source) {
    errors.push("tehsils: collection metadata missing count/source");
  }

  /* -------------------------------------------------------------- report */
  report.push(
    `districts   ${dFeatures.length}/41 features · names ${missing.length + extra.length === 0 ? "match target" : "MISMATCH"} · ` +
      `ids ${seenIds.size === ids.length ? "unique" : "DUPLICATES"} · attribution ${attributionOk ? "ok" : "BROKEN"}`,
  );
  report.push(
    `geometry    ${dFeatures.length - geometryIssues}/${dFeatures.length} valid · ${exteriorRings} exterior rings CCW · ` +
      `${geometryIssues} issue(s)`,
  );
  report.push(
    `tiling      ${overlaps.length} overlap pair(s) ${overlaps.length ? `(total ${fmt(overlapTotalKm2, 3)}, max ${fmt(overlapMaxKm2, 3)} km² ${overlapWorst})` : "(0 km²)"} · ` +
      `${unionHoleCount} gap ring(s) ${fmt(unionHoleKm2, 3)} km² · |sum−union| ${fmt(sumVsUnionKm2, 3)} km²`,
  );
  report.push(
    `area        sum ${fmt(featureSumKm2)} km² · union ${fmt(unionKm2)} km² · official ${fmt(THRESHOLDS.areaOfficialKm2)} ` +
      `±${THRESHOLDS.areaTolerancePct}% → ${areaDeltaPct >= 0 ? "+" : ""}${fmt(areaDeltaPct, 2)}%`,
  );
  report.push(
    `legacy 33   union ${fmt(legacyUnionKm2)} km² · uncovered ${fmt(legacyUncoveredKm2)} km² · expansion ${fmt(legacyExpansionKm2)} km² · ` +
      `min coverage ${legacyMinCoverage ? `${legacyMinCoverage.name} ${fmt(legacyMinCoverage.pct, 2)}%` : "n/a"}`,
  );
  report.push("deltas      legacy district → new set:");
  for (const d of legacyDeltas) {
    const renamed = d.sameName && d.sameName !== d.legacy ? `${d.sameName}: ` : "";
    const same =
      d.sameNameKm2 !== null && d.deltaPct !== null
        ? `${renamed}${fmt(d.legacyKm2)} → ${fmt(d.sameNameKm2)} km² (${d.deltaPct >= 0 ? "+" : ""}${fmt(d.deltaPct, 1)}%)`
        : "no same-name district";
    const coverStr = d.covers.map(([n, p]) => `${n} ${fmt(p)}%`).join(", ");
    report.push(`  ${d.legacy}: ${same} — covered by [${coverStr}]`);
  }
  report.push(
    `tehsils     ${tehsilCount} features · ids+geometry ${tehsilsUnchanged ? "unchanged" : "CHANGED"} · ` +
      `parents ${tehsilParentsValid ? "valid" : "INVALID"} · ${ids.length - uncoveredDistricts.length}/41 districts covered`,
  );

  return { errors, warnings, report, metrics: {
    districtCount: dFeatures.length,
    districtNames: [...names].sort(),
    districtIds: [...ids].sort(),
    geometryIssues,
    exteriorRings,
    districtAttributionOk: attributionOk,
    overlapPairCount: overlaps.length,
    overlapTotalKm2,
    overlapMaxKm2,
    overlapWorst,
    unionHoleCount,
    unionHoleKm2,
    featureSumKm2,
    unionKm2,
    sumVsUnionKm2,
    areaDeltaPct,
    legacyUnionKm2,
    legacyUncoveredKm2,
    legacyExpansionKm2,
    legacyMinCoverage,
    legacyDeltas,
    tehsilCount,
    tehsilsUnchanged,
    tehsilParentsValid,
    tehsilsPerDistrict,
  } };
}
