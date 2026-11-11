/**
 * Fetches the current 41 Rajasthan district boundaries (the 28–30 Dec 2024
 * reorganisation: Ajmer/Alwar/Bharatpur/Jodhpur/Udaipur divisions, 41
 * districts) from OpenStreetMap via the Overpass API (admin_level=5
 * relations), simplifies them slightly, and writes:
 *
 *   data/boundaries/districts.geojson   { id, name, source, retrievedAt, license }
 *
 * It also re-parents the existing Census-2011 tehsils (tehsils.geojson) to
 * the new districts by largest overlap area — tehsil ids and geometry are
 * unchanged, only parentId/districtId are updated — and reports OSM
 * admin_level=6 (tehsil) completeness for comparison against the 224
 * Census-2011 tehsils.
 *
 * Sources:
 *   Districts: OpenStreetMap © OpenStreetMap contributors, ODbL-1.0
 *     (Overpass: relations with admin_level=5 in Rajasthan)
 *   Tehsils (kept): Datameet Census 2011 taluk boundaries —
 *     https://github.com/datameet/taluk_boundaries (see data/boundaries/README.md)
 *
 * Census-era district ids are preserved (d-chittaurgarh, d-dhaulpur,
 * d-ganganagar, d-jalor keep their ids under the new canonical names);
 * new districts get d-<slug> ids. Alternate spellings resolve through
 * DISTRICT_ID_ALIASES in lib/data/boundaries.ts.
 *
 * NOT run during builds — run manually when refreshing client data:
 *
 *   npx tsx scripts/fetch-districts-41.ts                  # fetch + re-parent
 *   npx tsx scripts/fetch-districts-41.ts --reparent-only  # re-parent only
 *   npx tsx scripts/fetch-districts-41.ts --skip-osm-tehsils
 *   npx tsx scripts/fetch-districts-41.ts --assess-only    # OSM tehsil report
 *
 * Fetches via Overpass (bulk) and falls back to Nominatim (same OSM data)
 * when Overpass is at capacity.
 *
 * Requires dev deps already in package.json (@turf/turf).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  area,
  bbox,
  booleanPointInPolygon,
  centroid,
  feature,
  featureCollection,
  intersect,
  simplify,
  union,
} from "@turf/turf";
import { LEGACY_NAME_ALIASES, TARGET_DISTRICTS } from "../validation/boundaries";

/** Simplification tolerance in degrees (~50 m at Rajasthan latitudes). */
const SIMPLIFY_TOLERANCE = 0.0005;

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "RajasthanSatelliteExplorer-boundary-fetch/1.0 (GitHub: Vatxsal)";

/** OSM relation name → canonical target name (accepted spelling variants). */
const OSM_NAME_ALIASES: Record<string, string> = {
  Dhaulpur: "Dholpur",
  Salumbar: "Salumber",
};

const OUT_DIR = join(process.cwd(), "data", "boundaries");
const DISTRICTS_PATH = join(OUT_DIR, "districts.geojson");
const TEHSILS_PATH = join(OUT_DIR, "tehsils.geojson");
const LEGACY_DISTRICTS_PATH = join(OUT_DIR, "legacy", "districts-census-2011-33.geojson");

interface DistrictRecord {
  id: string;
  name: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  areaM2: number;
}

/* ------------------------------------------------------------------ utils */

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GeoJSON RFC 7946 winding: exterior CCW, holes CW (Sentinel Hub requires it). */
function ringSignedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  }
  return sum;
}

function orientRing(ring: number[][], exterior: boolean): number[][] {
  const isCcw = ringSignedArea(ring) > 0;
  return isCcw === exterior ? ring : [...ring].reverse();
}

function orientGeometry(geometry: GeoJSON.Geometry): GeoJSON.Geometry {
  if (geometry.type === "Polygon") {
    return {
      type: "Polygon",
      coordinates: geometry.coordinates.map((ring, i) => orientRing(ring, i === 0)),
    };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((poly) =>
        poly.map((ring, i) => orientRing(ring, i === 0)),
      ),
    };
  }
  return geometry;
}

function simplifyLine(coords: number[][]): number[][] {
  try {
    const result = simplify(feature({ type: "LineString", coordinates: coords }), {
      tolerance: SIMPLIFY_TOLERANCE,
      highQuality: false,
    });
    const out = (result.geometry as GeoJSON.LineString).coordinates;
    return out.length >= 2 ? out : coords;
  } catch {
    return coords;
  }
}

function dedupeConsecutive(coords: { lat: number; lon: number }[]): number[][] {
  const out: number[][] = [];
  for (const c of coords) {
    const pt = [Number(c.lon.toFixed(7)), Number(c.lat.toFixed(7))];
    const prev = out[out.length - 1];
    if (prev && prev[0] === pt[0] && prev[1] === pt[1]) continue;
    out.push(pt);
  }
  return out;
}

/* ----------------------------------------------------------- overpass I/O */

async function overpass(query: string, attempts = 6): Promise<OverpassResponse> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(360_000),
      });
      const text = await response.text();
      if (!response.ok || text.trimStart().startsWith("<")) {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(text) as OverpassResponse;
    } catch (error) {
      lastError = error;
      const waitMs = Math.min(60_000, Math.round(5_000 * 1.7 ** attempt));
      console.warn(
        `  Overpass attempt ${attempt + 1}/${attempts} failed (${String(
          (error as Error).message,
        ).slice(0, 120)}); retrying in ${Math.round(waitMs / 1000)}s…`,
      );
      await sleep(waitMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

interface OverpassGeomPoint {
  lat: number;
  lon: number;
}

interface OverpassMember {
  type: string;
  ref: number;
  role: string;
  geometry?: OverpassGeomPoint[];
}

interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  members?: OverpassMember[];
}

interface OverpassResponse {
  elements: OverpassElement[];
}

/* --------------------------------------------------------- ring assembly */

function nodeKey(c: number[]): string {
  return `${c[0]},${c[1]}`;
}

function isClosed(ring: number[][]): boolean {
  return ring.length >= 4 && nodeKey(ring[0]!) === nodeKey(ring[ring.length - 1]!);
}

/**
 * Stitches open way segments end-to-end into closed rings (OSM multipolygon
 * relations reference the same way objects for shared borders, so node keys
 * match exactly after coordinate quantisation).
 */
function assembleRings(ways: number[][][]): { rings: number[][][]; unclosed: number } {
  const rings: number[][][] = [];
  const pending = ways.filter((w) => w.length >= 2);
  let unclosed = 0;

  while (pending.length > 0) {
    let ring = pending.shift()!;
    let guard = pending.length + 4;
    while (!isClosed(ring) && guard > 0) {
      guard -= 1;
      const startKey = nodeKey(ring[0]!);
      const endKey = nodeKey(ring[ring.length - 1]!);
      let found = -1;
      let mode: "append" | "appendRev" | "prepend" | "prependRev" | null = null;
      for (let i = 0; i < pending.length; i += 1) {
        const w = pending[i]!;
        const wStart = nodeKey(w[0]!);
        const wEnd = nodeKey(w[w.length - 1]!);
        if (wStart === endKey) {
          found = i;
          mode = "append";
          break;
        }
        if (wEnd === endKey) {
          found = i;
          mode = "appendRev";
          break;
        }
        if (wEnd === startKey) {
          found = i;
          mode = "prepend";
          break;
        }
        if (wStart === startKey) {
          found = i;
          mode = "prependRev";
          break;
        }
      }
      if (found < 0 || !mode) break;
      const w = pending.splice(found, 1)[0]!;
      if (mode === "append") ring = ring.concat(w.slice(1));
      else if (mode === "appendRev") ring = ring.concat(w.slice(0, -1).reverse());
      else if (mode === "prepend") ring = w.slice(0, -1).concat(ring);
      else ring = w.slice(1).reverse().concat(ring);
    }
    if (isClosed(ring)) rings.push(ring);
    else unclosed += 1;
  }
  return { rings, unclosed };
}

function pointInRing(pt: number[], ring: number[][]): boolean {
  try {
    return booleanPointInPolygon(feature({ type: "Point", coordinates: pt }), feature({
      type: "Polygon",
      coordinates: [ring],
    }));
  } catch {
    return false;
  }
}

/** Builds a Polygon/MultiPolygon from closed outer/inner rings, RFC 7946 oriented. */
function buildPolygon(
  outerRings: number[][][],
  innerRings: number[][][],
  dropped: { holes: number },
): GeoJSON.Polygon | GeoJSON.MultiPolygon {
  const shells = outerRings.map((shell) => ({ shell, holes: [] as number[][][] }));
  for (const hole of innerRings) {
    const pt = hole[0]!;
    const containing = shells.filter((s) => pointInRing(pt, s.shell));
    if (containing.length === 0) {
      dropped.holes += 1;
      continue;
    }
    containing.sort((a, b) => Math.abs(ringSignedArea(a.shell)) - Math.abs(ringSignedArea(b.shell)));
    containing[0]!.holes.push(hole);
  }
  const polygons = shells.map((s) => [s.shell, ...s.holes].map((ring, i) => orientRing(ring, i === 0)));
  if (polygons.length === 0) throw new Error("no outer rings");
  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0]! };
  return { type: "MultiPolygon", coordinates: polygons };
}

/** Splits a relation's members into simplified, stitched outer/inner rings. */
function relationRings(
  members: OverpassMember[],
  simplifyCache: Map<number, number[][]>,
  stats: { subRelations: number; unclosed: number },
): { outer: number[][][]; inner: number[][][] } {
  const outerWays: number[][][] = [];
  const innerWays: number[][][] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (member.type === "relation") {
      stats.subRelations += 1;
      continue;
    }
    if (member.type !== "way" || !member.geometry || member.geometry.length < 2) continue;
    const deduped = dedupeConsecutive(member.geometry);
    if (deduped.length < 2) continue;
    const key = `${member.role}:${member.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let simplified = simplifyCache.get(member.ref);
    if (!simplified) {
      simplified = simplifyLine(deduped);
      simplifyCache.set(member.ref, simplified);
    }
    if (member.role === "inner") innerWays.push(simplified);
    else outerWays.push(simplified);
  }
  const outers = assembleRings(outerWays);
  const inners = assembleRings(innerWays);
  stats.unclosed += outers.unclosed + inners.unclosed;
  return { outer: outers.rings, inner: inners.rings };
}

/* --------------------------------------------------------------- districts */

function canonicalDistrictName(osmName: string): string | null {
  const mapped = OSM_NAME_ALIASES[osmName] ?? osmName;
  return (TARGET_DISTRICTS as readonly string[]).includes(mapped) ? mapped : null;
}

/** canonical name → Census-era id (from the legacy snapshot), for the 33 old ids. */
function loadLegacyIds(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(LEGACY_DISTRICTS_PATH)) return map;
  const legacy = JSON.parse(readFileSync(LEGACY_DISTRICTS_PATH, "utf8")) as GeoJSON.FeatureCollection;
  for (const f of legacy.features) {
    const oldName = String(f.properties?.name ?? "");
    const id = String(f.properties?.id ?? "");
    if (!oldName || !id) continue;
    map.set(LEGACY_NAME_ALIASES[oldName] ?? oldName, id);
  }
  return map;
}

async function fetchDistricts(): Promise<DistrictRecord[]> {
  console.log("Fetching district relations from Overpass (admin_level=5)…");
  const query = `
[out:json][timeout:300];
area["name"="Rajasthan"]["admin_level"="4"]->.rj;
relation(area.rj)["admin_level"="5"]["boundary"="administrative"];
out geom;
`.trim();
  const response = await overpass(query);
  const relations = response.elements.filter((e) => e.type === "relation");
  console.log(`  ${relations.length} admin_level=5 relations`);

  const simplifyCache = new Map<number, number[][]>();
  const candidates: { canonical: string; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }[] = [];
  const problems: string[] = [];
  const stats = { subRelations: 0, unclosed: 0 };
  const droppedHoles = { holes: 0 };

  for (const rel of relations) {
    const osmName = rel.tags?.name ?? "";
    const canonical = canonicalDistrictName(osmName);
    if (!canonical) {
      problems.push(`unexpected district name "${osmName}" (relation ${rel.id})`);
      continue;
    }
    if (!rel.members || rel.members.length === 0) {
      problems.push(`relation for "${canonical}" has no members`);
      continue;
    }
    const { outer, inner } = relationRings(rel.members, simplifyCache, stats);
    if (outer.length === 0) {
      problems.push(`no closed outer rings for "${canonical}"`);
      continue;
    }
    candidates.push({
      canonical,
      geometry: buildPolygon(outer, inner, droppedHoles) as
        | GeoJSON.Polygon
        | GeoJSON.MultiPolygon,
    });
  }

  if (stats.subRelations > 0) {
    problems.push(`${stats.subRelations} nested sub-relation members were skipped`);
  }
  if (stats.unclosed > 0) problems.push(`${stats.unclosed} ways could not be stitched into rings`);
  if (droppedHoles.holes > 0) problems.push(`${droppedHoles.holes} inner rings had no containing shell`);

  return finalizeRecords(candidates, problems);
}

/* -------------------------------------------------- Nominatim fallback */

interface NominatimResult {
  osm_type?: string;
  osm_id?: number;
  class?: string;
  type?: string;
  display_name?: string;
  geojson?: GeoJSON.Geometry;
  extratags?: Record<string, string>;
  address?: Record<string, string>;
}

/** Canonical name → OSM spelling, tried when the canonical query finds nothing. */
const NOMINATIM_NAME_ALIASES: Record<string, string> = {
  Dholpur: "Dhaulpur",
  Salumber: "Salumbar",
};

function flattenGeometry(geometry: GeoJSON.Geometry): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return geometry;
  if (geometry.type === "GeometryCollection") {
    const polys: GeoJSON.Polygon[] = [];
    for (const part of geometry.geometries) {
      const flat = flattenGeometry(part);
      if (!flat) continue;
      if (flat.type === "Polygon") polys.push(flat);
      else for (const poly of flat.coordinates) polys.push({ type: "Polygon", coordinates: poly });
    }
    if (polys.length === 0) return null;
    if (polys.length === 1) return polys[0]!;
    return { type: "MultiPolygon", coordinates: polys.map((p) => p.coordinates) };
  }
  return null;
}

async function nominatimSearch(q: string): Promise<NominatimResult[]> {
  const url = `${NOMINATIM_URL}?${new URLSearchParams({
    q,
    format: "jsonv2",
    polygon_geojson: "1",
    extratags: "1",
    limit: "8",
  })}`;
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status} for "${q}"`);
  return (await response.json()) as NominatimResult[];
}

/**
 * Fallback when Overpass is at capacity: Nominatim (same OSM data, ODbL)
 * with polygon_geojson=1, one district at a time at ≤1 request/second.
 * Geometry arrives pre-assembled, so rings are simplified per-district
 * (shared borders stay within tolerance rather than bit-identical).
 */
async function fetchDistrictsViaNominatim(): Promise<DistrictRecord[]> {
  console.log("Falling back to Nominatim (41 requests, ~1/s)…");
  const candidates: { canonical: string; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }[] = [];
  const problems: string[] = [];

  for (const canonical of TARGET_DISTRICTS) {
    const queries = [canonical, NOMINATIM_NAME_ALIASES[canonical]].filter(
      (q): q is string => Boolean(q),
    );
    let picked: { canonical: string; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon } | null =
      null;
    for (const q of queries) {
      let results: NominatimResult[];
      try {
        results = await nominatimSearch(`${q}, Rajasthan, India`);
      } catch (error) {
        problems.push(`Nominatim query failed for "${q}": ${(error as Error).message}`);
        continue;
      }
      await sleep(1_100);
      const match = results.find(
        (r) =>
          r.osm_type === "relation" &&
          r.class === "boundary" &&
          r.type === "administrative" &&
          r.extratags?.admin_level === "5" &&
          Boolean(r.geojson),
      );
      if (match?.geojson) {
        const geometry = flattenGeometry(match.geojson);
        if (geometry) {
          picked = { canonical, geometry };
          break;
        }
      }
    }
    if (picked) {
      candidates.push(picked);
      console.log(`  ✓ ${canonical}`);
    } else {
      problems.push(`no admin_level=5 boundary found for "${canonical}"`);
      console.log(`  ✗ ${canonical}`);
    }
  }

  return finalizeRecords(candidates, problems);
}

/** Shared tail: id assignment (Census-era ids preserved), 41/41 validation. */
function finalizeRecords(
  candidates: { canonical: string; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }[],
  problems: string[],
): DistrictRecord[] {
  const legacyIds = loadLegacyIds();
  const seenIds = new Set<string>();
  const records: DistrictRecord[] = [];

  for (const c of candidates) {
    const id = legacyIds.get(c.canonical) ?? `d-${slug(c.canonical)}`;
    if (seenIds.has(id)) {
      problems.push(`duplicate id ${id} for "${c.canonical}"`);
      continue;
    }
    seenIds.add(id);
    records.push({
      id,
      name: c.canonical,
      geometry: c.geometry,
      areaM2: area(feature(c.geometry)),
    });
  }

  const names = new Set(records.map((r) => r.name));
  const missing = TARGET_DISTRICTS.filter((n) => !names.has(n));
  if (missing.length > 0) problems.push(`missing districts: ${missing.join(", ")}`);

  if (records.length !== 41 || missing.length > 0) {
    throw new Error(
      `district fetch produced ${records.length}/41 districts — aborting before write.\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
  if (problems.length > 0) {
    console.warn("  warnings:");
    for (const p of problems) console.warn(`    - ${p}`);
  }

  records.sort((a, b) => a.name.localeCompare(b.name));
  return records;
}

function writeDistricts(records: DistrictRecord[], retrievedAt: string, via: string): void {
  const features: GeoJSON.Feature[] = records.map((r) => ({
    type: "Feature",
    properties: {
      id: r.id,
      name: r.name,
      source: "OpenStreetMap",
      retrievedAt,
      license: "ODbL-1.0",
    },
    geometry: r.geometry,
  }));
  const doc = {
    type: "FeatureCollection",
    metadata: {
      source: `OpenStreetMap (${via}, admin_level=5 relations in Rajasthan)`,
      license: "ODbL-1.0",
      attribution: "© OpenStreetMap contributors",
      retrievedAt,
      count: features.length,
      note:
        "Current 41 districts (28–30 Dec 2024 reorganisation). Census-2011 era ids preserved where they existed; alternate spellings resolve via DISTRICT_ID_ALIASES in lib/data/boundaries.ts.",
    },
    features,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(DISTRICTS_PATH, JSON.stringify(doc));
  console.log(`Wrote ${features.length} districts → data/boundaries/districts.geojson (via ${via})`);
}

/* --------------------------------------------------------------- tehsils */

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function bboxOf(geometry: GeoJSON.Geometry): BBox {
  const [minX, minY, maxX, maxY] = bbox(feature(geometry));
  return { minX, minY, maxX, maxY };
}

function bboxOverlap(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

function reParentTehsils(districts: DistrictRecord[]): void {
  console.log("Re-parenting Census-2011 tehsils to the new districts (largest overlap)…");
  const doc = JSON.parse(readFileSync(TEHSILS_PATH, "utf8")) as GeoJSON.FeatureCollection;
  const districtBBoxes = districts.map((d) => ({ d, bbox: bboxOf(d.geometry) }));
  const districtIds = new Set(districts.map((d) => d.id));
  const changes: { id: string; name: string; from: string; to: string }[] = [];
  const warnings: string[] = [];
  let unchanged = 0;

  for (const tehsil of doc.features) {
    const geometry = tehsil.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
    if (!geometry) continue;
    const id = String(tehsil.properties?.id ?? "?");
    const name = String(tehsil.properties?.name ?? id);
    const previous = String(tehsil.properties?.districtId ?? "");
    const tBox = bboxOf(geometry);

    let best: DistrictRecord | null = null;
    let bestArea = 0;
    for (const { d, bbox: dBox } of districtBBoxes) {
      if (!bboxOverlap(tBox, dBox)) continue;
      try {
        const overlap = intersect(featureCollection([feature(geometry), feature(d.geometry)]));
        if (!overlap) continue;
        const overlapArea = area(overlap);
        if (overlapArea > bestArea) {
          bestArea = overlapArea;
          best = d;
        }
      } catch {
        // Invalid intersection geometry — try the next candidate.
      }
    }
    if (!best) {
      // Fallback: district containing the tehsil centroid.
      const centre = centroid(feature(geometry));
      best = districts.find((d) => {
        try {
          return booleanPointInPolygon(centre, feature(d.geometry));
        } catch {
          return false;
        }
      }) ?? null;
    }
    if (!best) {
      warnings.push(`no district overlaps "${name}" (${id}) — keeping parent ${previous}`);
      if (previous && districtIds.has(previous)) unchanged += 1;
      continue;
    }
    if (best.id !== previous) {
      changes.push({ id, name, from: previous, to: best.id });
    } else {
      unchanged += 1;
    }
    tehsil.properties = {
      ...(tehsil.properties ?? {}),
      parentId: best.id,
      districtId: best.id,
    };
  }

  const retrievedAt = new Date().toISOString().slice(0, 10);
  const parents = new Set(
    doc.features.map((f) => String(f.properties?.districtId ?? "")).filter(Boolean),
  );
  const covered = districts.filter((d) => parents.has(d.id));
  const docWithMeta = {
    type: "FeatureCollection",
    metadata: {
      source: "Datameet Census 2011 taluk boundaries (datameet/taluk_boundaries)",
      license: "see upstream repository (no explicit licence file)",
      note:
        "Census-2011 tehsil boundaries — may not match current tehsils. Re-parented to the 41-district (2024) layout by largest overlap; geometry and ids unchanged.",
      reparentedAt: retrievedAt,
      count: doc.features.length,
    },
    features: doc.features,
  };
  writeFileSync(TEHSILS_PATH, JSON.stringify(docWithMeta));
  console.log(
    `  ${doc.features.length} tehsils: ${unchanged} kept parent, ${changes.length} re-parented → data/boundaries/tehsils.geojson`,
  );
  for (const c of changes) console.log(`    ${c.id} (${c.name}): ${c.from} → ${c.to}`);
  for (const w of warnings) console.warn(`    warning: ${w}`);
  const noTehsils = districts.filter((d) => !parents.has(d.id)).map((d) => d.name);
  if (noTehsils.length > 0) {
    console.warn(`    districts with no tehsil parented to them: ${noTehsils.join(", ")}`);
  }
  console.log(`  districts with ≥1 tehsil: ${covered.length}/${districts.length}`);
}

/* --------------------------------------------- OSM tehsil assessment (info) */

async function assessOsmTehsils(stateAreaM2: number): Promise<void> {
  console.log("Assessing OSM admin_level=6 units vs the Census-2011 tehsils…");
  const query = `
[out:json][timeout:300];
area["name"="Rajasthan"]["admin_level"="4"]->.rj;
relation(area.rj)["admin_level"="6"]["boundary"="administrative"];
out geom;
`.trim();
  const response = await overpass(query);
  const relations = response.elements.filter((e) => e.type === "relation" && e.members?.length);
  const simplifyCache = new Map<number, number[][]>();
  const stats = { subRelations: 0, unclosed: 0 };
  const droppedHoles = { holes: 0 };
  const geometries: (GeoJSON.Polygon | GeoJSON.MultiPolygon)[] = [];
  const names: string[] = [];
  let failed = 0;

  for (const rel of relations) {
    try {
      const { outer, inner } = relationRings(rel.members!, simplifyCache, stats);
      if (outer.length === 0) {
        failed += 1;
        continue;
      }
      geometries.push(buildPolygon(outer, inner, droppedHoles));
      names.push(rel.tags?.name ?? "(unnamed)");
    } catch {
      failed += 1;
    }
  }

  const uniqueNames = new Set(names);
  const tehsilSuffix = names.filter((n) => /tehsil$/i.test(n)).length;
  const sumAreaM2 = geometries.reduce((sum, g) => {
    try {
      return sum + area(feature(g));
    } catch {
      return sum;
    }
  }, 0);

  let unionAreaM2 = 0;
  let unionOk = false;
  try {
    const united = union(featureCollection(geometries.map((g) => feature(g))));
    if (united) {
      unionAreaM2 = area(united);
      unionOk = true;
    }
  } catch {
    // fall through — report sum only
  }

  const census = JSON.parse(readFileSync(TEHSILS_PATH, "utf8")) as GeoJSON.FeatureCollection;
  const censusSumM2 = census.features.reduce((sum, f) => {
    try {
      return sum + area(feature(f.geometry!));
    } catch {
      return sum;
    }
  }, 0);

  const km2 = (m2: number): string => Math.round(m2 / 1e6).toLocaleString();
  console.log(`  OSM admin_level=6: ${relations.length} relations, ${uniqueNames.size} unique names, ${tehsilSuffix} named "…Tehsil"`);
  if (failed > 0) console.log(`  assembly failures: ${failed}`);
  console.log(`  OSM sum area: ${km2(sumAreaM2)} km² (state≈ ${km2(stateAreaM2)} km²)`);
  if (unionOk) {
    const coverage = (100 * unionAreaM2) / stateAreaM2;
    console.log(`  OSM union area: ${km2(unionAreaM2)} km² → ${coverage.toFixed(2)}% of state`);
    console.log(`  gaps vs state: ${km2(Math.max(0, stateAreaM2 - unionAreaM2))} km² · overlaps (sum−union): ${km2(Math.max(0, sumAreaM2 - unionAreaM2))} km²`);
  } else {
    console.log("  union unavailable (reported sum only)");
  }
  console.log(`  Census-2011 tehsils: ${census.features.length} · sum area ${km2(censusSumM2)} km²`);
  const normalise = (n: string): string => n.toLowerCase().replace(/\s+tehsil$/, "").trim();
  const osmNameSet = new Set(names.map(normalise));
  const censusNames = census.features.map((f) => normalise(String(f.properties?.name ?? "")));
  const matched = censusNames.filter((n) => osmNameSet.has(n)).length;
  console.log(`  Census tehsil names found in OSM: ${matched}/${censusNames.length}`);
}

/* ------------------------------------------------------------------- main */

function loadDistrictsFromFile(): DistrictRecord[] {
  const doc = JSON.parse(readFileSync(DISTRICTS_PATH, "utf8")) as GeoJSON.FeatureCollection;
  return doc.features.map((f) => ({
    id: String(f.properties?.id ?? ""),
    name: String(f.properties?.name ?? ""),
    geometry: f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon,
    areaM2: area(feature(f.geometry!)),
  }));
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const reparentOnly = args.has("--reparent-only");
  const skipOsmTehsils = args.has("--skip-osm-tehsils");
  const assessOnly = args.has("--assess-only");
  const retrievedAt = new Date().toISOString().slice(0, 10);

  if (assessOnly) {
    const districts = loadDistrictsFromFile();
    await assessOsmTehsils(districts.reduce((sum, d) => sum + d.areaM2, 0));
    return;
  }

  let districts: DistrictRecord[];
  if (reparentOnly) {
    districts = loadDistrictsFromFile();
    console.log(`Loaded ${districts.length} districts from data/boundaries/districts.geojson (--reparent-only)`);
  } else {
    let via = "Overpass API";
    try {
      districts = await fetchDistricts();
    } catch (error) {
      console.warn(
        `Overpass unavailable (${String((error as Error).message).slice(0, 160)}); trying Nominatim fallback…`,
      );
      districts = await fetchDistrictsViaNominatim();
      via = "Nominatim";
    }
    writeDistricts(districts, retrievedAt, via);
  }

  reParentTehsils(districts);

  const totalKm2 = districts.reduce((sum, d) => sum + d.areaM2, 0) / 1e6;
  console.log("\nDistrict areas:");
  for (const d of districts) {
    console.log(`  ${d.id.padEnd(26)} ${d.name.padEnd(20)} ${Math.round(d.areaM2 / 1e6).toLocaleString().padStart(7)} km²`);
  }
  console.log(`  total ${Math.round(totalKm2).toLocaleString()} km² (Rajasthan ≈ 342,000 km², ±2% → 335,160–348,840)`);

  if (!reparentOnly && !skipOsmTehsils) {
    try {
      await assessOsmTehsils(districts.reduce((sum, d) => sum + d.areaM2, 0));
    } catch (error) {
      console.warn(
        `OSM tehsil assessment skipped (Overpass unavailable): ${String((error as Error).message).slice(0, 160)}`,
      );
      console.warn("  re-run later with: npx tsx scripts/fetch-districts-41.ts --assess-only");
    }
  }

  console.log("\nDone. Run `npx tsx scripts/validate-boundaries.ts` (or npm run validate:boundaries) to validate.");
}

main().catch((error) => {
  console.error("fetch-districts-41 failed:", error);
  process.exitCode = 1;
});
