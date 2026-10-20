import { booleanValid, feature } from "@turf/turf";
import realDistrictsFc from "@/data/boundaries/districts.geojson";
import realTehsilsFc from "@/data/boundaries/tehsils.geojson";
import mockDistrictsFc from "@/data/mock/districts.geojson";
import mockIlrsFc from "@/data/mock/ilrs.geojson";
import mockTehsilsFc from "@/data/mock/tehsils.geojson";

/**
 * Active boundary datasets. Prefers the Datameet-derived files written by
 * `scripts/fetch-datameet.ts` (data/boundaries/*.geojson) and falls back to
 * the bundled mock boundaries while those are empty/placeholder. ILR units
 * stay on the mock set (empty in practice) until real data arrives.
 */

type FeatureCollection = GeoJSON.FeatureCollection;

/**
 * GeoJSON RFC 7946 winding: exterior rings CCW, holes CW. Shapefile/TopoJSON
 * sources (Datameet) use the opposite convention, and Sentinel Hub's geometry
 * mask treats clockwise exteriors as holes — yielding fully transparent
 * renders. Normalise once at load so every consumer gets RFC-correct rings.
 */
function ringSignedArea(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    sum += ring[i]![0]! * ring[i + 1]![1]! - ring[i + 1]![0]! * ring[i]![1]!;
  }
  return sum;
}

function orientRing(ring: number[][], exterior: boolean): number[][] {
  const isCcw = ringSignedArea(ring) > 0;
  const wantCcw = exterior;
  return isCcw === wantCcw ? ring : [...ring].reverse();
}

function normalizeGeometry(geometry: GeoJSON.Geometry): GeoJSON.Geometry {
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

function orientFeatureCollection(fc: FeatureCollection): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: fc.features.map((f) => ({
      ...f,
      geometry: f.geometry ? normalizeGeometry(f.geometry) : f.geometry,
    })),
  };
}

function pick(real: FeatureCollection, mock: FeatureCollection): FeatureCollection {
  // Real files are re-normalised in case they were generated pre-fix.
  return real.features.length > 0 ? orientFeatureCollection(real) : mock;
}

export const districtsFc: FeatureCollection = pick(realDistrictsFc as FeatureCollection, mockDistrictsFc as FeatureCollection);
export const tehsilsFc: FeatureCollection = pick(realTehsilsFc as FeatureCollection, mockTehsilsFc as FeatureCollection);
export const ilrsFc: FeatureCollection = mockIlrsFc as FeatureCollection;

/** True when the live Datameet boundaries are active (vs mock fallback). */
export const usingRealBoundaries = (realDistrictsFc as FeatureCollection).features.length > 0;

/**
 * Warn (once per load) about invalid or self-intersecting boundary geometry
 * so bad source data is visible in the console instead of failing renders.
 */
function warnInvalidGeometries(fc: FeatureCollection, label: string): void {
  const seen = new Set<string>();
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const name = String((f.properties as Record<string, unknown> | null)?.name ?? "?");
    const key = `${label}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const valid = booleanValid(feature(f.geometry) as Parameters<typeof booleanValid>[0]);
      if (!valid) {
        // eslint-disable-next-line no-console -- data-quality warning
        console.warn(`[boundaries] ${label} "${name}" geometry is invalid or self-intersecting.`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console -- data-quality warning
      console.warn(`[boundaries] ${label} "${name}" geometry failed validation:`, error);
    }
  }
}

warnInvalidGeometries(districtsFc, "district");
warnInvalidGeometries(tehsilsFc, "tehsil");
