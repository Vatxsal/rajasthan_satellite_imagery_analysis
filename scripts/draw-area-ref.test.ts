import "./alias-hook"; // must be first: installs the "@/…" resolver before the route graph loads

import assert from "node:assert/strict";
import test from "node:test";
import {
  booleanPointInPolygon,
  centroid,
  feature,
  pointOnFeature,
  polygon,
} from "@turf/turf";
import { districtsFc } from "../lib/data/boundaries";
import { resolveAreaRef, type AreaRef } from "../lib/server/areaRef";

/** Small square (~17 km²) around an interior point of the first district —
 *  inside Rajasthan by construction, well under the area/bbox limits. */
function rajasthanSquare(): GeoJSON.Polygon {
  const district = districtsFc.features[0];
  assert.ok(district?.geometry, "boundaries fixture must load");
  const anchor = pointOnFeature(feature(district.geometry)).geometry.coordinates;
  const [lng, lat] = anchor;
  const d = 0.02;
  return polygon([
    [
      [lng - d, lat - d],
      [lng + d, lat - d],
      [lng + d, lat + d],
      [lng - d, lat + d],
      [lng - d, lat - d],
    ],
  ]).geometry;
}

test("resolveAreaRef: admin refs resolve with kind admin and full ResolvedArea", () => {
  const ref: AreaRef = { kind: "admin", level: "district", areaId: "d-jaipur" };
  const resolved = resolveAreaRef(ref);
  assert.ok(resolved, "d-jaipur should resolve");
  assert.equal(resolved.kind, "admin");
  if (resolved.kind !== "admin") return;
  assert.equal(resolved.level, "district");
  assert.equal(resolved.id, "d-jaipur");
  assert.ok(resolved.name.length > 0);
  assert.equal(resolved.bbox.length, 4);
});

test("resolveAreaRef: unknown admin id resolves to null", () => {
  assert.equal(resolveAreaRef({ kind: "admin", level: "district", areaId: "d-not-a-place" }), null);
  assert.equal(resolveAreaRef({ kind: "admin", level: "ilr", areaId: "nope" }), null);
});

test("resolveAreaRef: valid shape resolves with stable content-hash id", () => {
  const geometry = rajasthanSquare();
  const resolved = resolveAreaRef({ kind: "shape", geometry, name: "  My field  " });
  assert.ok(resolved, "interior square should resolve");
  assert.equal(resolved.kind, "shape");
  if (resolved.kind !== "shape") return;
  assert.match(resolved.id, /^shape:[0-9a-f]{16}$/);
  assert.equal(resolved.name, "My field", "name trims");
  assert.equal(resolved.bbox.length, 4);
  assert.ok(resolved.geometry.coordinates[0].length >= 4);

  // Same drawing, default name, extra duplicate point → identical id (content
  // hash dedupes; normalisation drops the duplicate before hashing).
  const dupe = rajasthanSquare();
  dupe.coordinates[0].splice(1, 0, [...dupe.coordinates[0][0]!]);
  const again = resolveAreaRef({ kind: "shape", geometry: dupe });
  assert.ok(again && again.kind === "shape");
  assert.equal(again.id, resolved.id);
  assert.equal(again.name, "Custom shape");
});

test("resolveAreaRef: districtId matches the district under the centroid", () => {
  const geometry = rajasthanSquare();
  const resolved = resolveAreaRef({ kind: "shape", geometry });
  assert.ok(resolved && resolved.kind === "shape");
  const point = centroid(feature(geometry));
  const expected = districtsFc.features.find(
    (f) =>
      f.geometry &&
      (f.geometry.type === "Polygon" || f.geometry.type === "MultiPolygon") &&
      booleanPointInPolygon(point, f.geometry),
  );
  assert.equal(
    resolved.districtId,
    String(expected?.properties?.id ?? ""),
    "wiring: same district the containing-boundary lookup finds",
  );
});

test("resolveAreaRef: rule violations resolve to null", () => {
  // Outside Rajasthan (structure/area/bbox fine — inside-check fails).
  const outside = polygon([
    [
      [80.0, 10.0],
      [80.02, 10.0],
      [80.02, 10.02],
      [80.0, 10.02],
      [80.0, 10.0],
    ],
  ]).geometry;
  assert.equal(resolveAreaRef({ kind: "shape", geometry: outside }), null);

  // Unclosed ring → pending, never an area.
  const closed = polygon([
    [
      [75.0, 26.0],
      [75.02, 26.0],
      [75.02, 26.02],
      [75.0, 26.02],
      [75.0, 26.0],
    ],
  ]).geometry;
  const unclosed: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [closed.coordinates[0]!.slice(0, -1)],
  };
  assert.equal(resolveAreaRef({ kind: "shape", geometry: unclosed }), null);

  // 1° × 1° near Jaipur ≈ 11 000 km² — over DRAW_MAX_KM2.
  const huge = polygon([
    [
      [75.0, 26.0],
      [76.0, 26.0],
      [76.0, 27.0],
      [75.0, 27.0],
      [75.0, 26.0],
    ],
  ]).geometry;
  assert.equal(resolveAreaRef({ kind: "shape", geometry: huge }), null);
});
