/**
 * Fetches Rajasthan district and tehsil (taluk) boundaries from Datameet's
 * Census 2011 repos, filters to Rajasthan, simplifies slightly, and writes:
 *
 *   data/boundaries/districts.geojson   { id, name }
 *   data/boundaries/tehsils.geojson     { id, name, parentId, districtId }
 *
 * Sources:
 *   Districts (Census 2011, TopoJSON):
 *     https://github.com/datameet/indian-district-boundaries
 *   Tehsils/taluks (shapefile, STATE/TALUK/DISTRICT attributes):
 *     https://github.com/datameet/taluk_boundaries
 *
 * NOT run during builds — run manually when refreshing client data:
 *
 *   npx tsx scripts/fetch-datameet.ts
 *
 * Requires dev deps (already in package.json): topojson-client, shapefile.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  area,
  booleanPointInPolygon,
  centroid,
  feature,
  featureCollection,
  simplify,
} from "@turf/turf";
import * as topojson from "topojson-client";
import * as shapefile from "shapefile";

/** Simplification tolerance in degrees (~50 m at Rajasthan latitudes). */
const SIMPLIFY_TOLERANCE = 0.0005;
const STATE_MATCH = /rajasthan/i;

const DISTRICTS_TOPOJSON_URL =
  "https://raw.githubusercontent.com/datameet/indian-district-boundaries/master/topojson/india-districts-727.json";
const TALUK_BASE_URL =
  "https://raw.githubusercontent.com/datameet/taluk_boundaries/master/INDIA_ADMIN_3_2739";

const OUT_DIR = join(process.cwd(), "data", "boundaries");
const TMP_DIR = join(process.cwd(), "node_modules", ".cache", "fetch-datameet");

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function simplifyGeometry(geometry: GeoJSON.Geometry): GeoJSON.Geometry {
  try {
    const simplified = simplify(featureCollection([feature(geometry)]), {
      tolerance: SIMPLIFY_TOLERANCE,
      highQuality: false,
    }).features[0]!;
    return simplified.geometry;
  } catch (error) {
    console.warn("  simplify failed, keeping original:", error);
    return geometry;
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  // ------------------------------------------------------------- districts
  console.log("Fetching Census 2011 district TopoJSON…");
  const topoBuffer = await fetchBuffer(DISTRICTS_TOPOJSON_URL);
  const topology = JSON.parse(topoBuffer.toString("utf8")) as {
    objects: Record<string, unknown>;
  };
  const objectKey = Object.keys(topology.objects)[0]!;
  const districtFc = (
    topojson as unknown as { feature(t: unknown, o: unknown): GeoJSON.FeatureCollection }
  ).feature(topology, topology.objects[objectKey]);

  const districts = districtFc.features.filter((f) =>
    STATE_MATCH.test(String((f.properties as Record<string, unknown>)?.st_nm ?? "")),
  );
  console.log(`  ${districts.length} Rajasthan districts (Census 2011)`);

  const districtOut: GeoJSON.Feature[] = [];
  const districtIndex: { id: string; name: string; geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon }[] = [];

  for (const f of districts) {
    const name = String((f.properties as Record<string, unknown>)?.district ?? "").trim();
    if (!name || !f.geometry) continue;
    const geometry = orientGeometry(simplifyGeometry(f.geometry)) as
      | GeoJSON.Polygon
      | GeoJSON.MultiPolygon;
    const id = `d-${slug(name)}`;
    districtOut.push({ type: "Feature", properties: { id, name }, geometry });
    districtIndex.push({ id, name, geometry });
  }

  // --------------------------------------------------------------- tehsils
  console.log("Fetching taluk (tehsil) shapefile…");
  for (const ext of ["shp", "dbf", "shx"]) {
    const buffer = await fetchBuffer(`${TALUK_BASE_URL}.${ext}`);
    writeFileSync(join(TMP_DIR, `taluk.${ext}`), buffer);
  }
  const talukSource = await shapefile.open(join(TMP_DIR, "taluk.shp"), join(TMP_DIR, "taluk.dbf"));

  const tehsilOut: GeoJSON.Feature[] = [];
  const seenTehsilIds = new Set<string>();
  let skipped = 0;

  for (
    let result = await talukSource.read();
    !result.done;
    result = await talukSource.read()
  ) {
    const raw = result.value;
    const props = (raw?.properties ?? {}) as Record<string, unknown>;
    const state = String(props.STATE ?? "").trim();
    const taluk = String(props.TALUK ?? "").trim();
    const districtName = String(props.DISTRICT ?? "").trim();
    if (!STATE_MATCH.test(state) || !taluk || !raw.geometry) {
      if (STATE_MATCH.test(state)) skipped += 1;
      continue;
    }

    const district =
      districtIndex.find((d) => d.name.toLowerCase() === districtName.toLowerCase()) ??
      // Fallback: district whose polygon contains the taluk centroid.
      districtIndex.find((d) => {
        try {
          return booleanPointInPolygon(centroid(feature(raw.geometry)), feature(d.geometry));
        } catch {
          return false;
        }
      });
    if (!district) {
      skipped += 1;
      continue;
    }

    const geometry = orientGeometry(simplifyGeometry(raw.geometry)) as
      | GeoJSON.Polygon
      | GeoJSON.MultiPolygon;
    let id = `t-${slug(district.name)}-${slug(taluk)}`;
    if (seenTehsilIds.has(id)) id = `${id}-2`;
    seenTehsilIds.add(id);

    tehsilOut.push({
      type: "Feature",
      // parentId is the spec-facing name; districtId is what the adapter reads.
      properties: { id, name: taluk, parentId: district.id, districtId: district.id },
      geometry,
    });
  }

  // ------------------------------------------------------------ write files
  const districtsDoc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: districtOut,
  };
  const tehsilsDoc: GeoJSON.FeatureCollection = {
    type: "FeatureCollection",
    features: tehsilOut,
  };
  writeFileSync(join(OUT_DIR, "districts.geojson"), JSON.stringify(districtsDoc));
  writeFileSync(join(OUT_DIR, "tehsils.geojson"), JSON.stringify(tehsilsDoc));

  const tehsilAreaKm2 =
    tehsilOut.reduce((sum, f) => {
      try {
        return sum + area(feature(f.geometry));
      } catch {
        return sum;
      }
    }, 0) / 1e6;

  console.log(`Wrote ${districtOut.length} districts → data/boundaries/districts.geojson`);
  console.log(
    `Wrote ${tehsilOut.length} tehsils → data/boundaries/tehsils.geojson (skipped ${skipped}, ~${Math.round(tehsilAreaKm2).toLocaleString()} km² total)`,
  );
}

main().catch((error) => {
  console.error("fetch-datameet failed:", error);
  process.exitCode = 1;
});
