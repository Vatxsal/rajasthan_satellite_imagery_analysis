import assert from "node:assert/strict";
import test from "node:test";
import { CLASS } from "../lib/analysis/config";
import { findPatchAt, inspectChangeAt, type ClassGridRef } from "../lib/inspect/changeGrid";

/**
 * /api/compare/inspect pure logic: north-up pixel mapping with clamping,
 * class → kind mapping (none/change/masked/outside), patch point-in-polygon
 * with bbox rejection, and the response shape the inspector card renders.
 */

/** 4×4 grid over [72, 24] → [74, 26]: 0.5° px, index = row * 4 + col. */
function gridRef(fill: number = CLASS.noChange): ClassGridRef {
  return {
    grid: new Uint8Array(16).fill(fill),
    width: 4,
    height: 4,
    bbox: [72, 24, 74, 26],
  };
}

const patchSquare: GeoJSON.Feature = {
  type: "Feature",
  id: "ev_abc12345",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [72.75, 24.75],
        [73.25, 24.75],
        [73.25, 25.25],
        [72.75, 25.25],
        [72.75, 24.75],
      ],
    ],
  },
  properties: {
    id: "ev_abc12345",
    label: 3,
    classCode: CLASS.vegLoss,
    classLabel: "Vegetation loss",
    areaHa: 12.5,
    confidence: "high",
    confidencePct: 87.5,
    subLabel: "Likely harvest / crop cycle",
    bbox: [72.75, 24.75, 73.25, 25.25],
  },
};

test("inspectChangeAt: no-change pixel → none, no patch even inside one", () => {
  const result = inspectChangeAt(gridRef(), [patchSquare], 73, 25);
  assert.equal(result.kind, "none");
  assert.equal(result.classCode, CLASS.noChange);
  assert.equal(result.classLabel, "No change");
  assert.equal(result.patch, null);
});

test("inspectChangeAt: change pixel → class + patch facts (confidence rounded, evidence)", () => {
  const input = gridRef();
  input.grid[2 * 4 + 2] = CLASS.vegLoss; // row 2, col 2 → (73, 25)
  const result = inspectChangeAt(input, [patchSquare], 73, 25);
  assert.equal(result.kind, "change");
  assert.equal(result.classCode, CLASS.vegLoss);
  assert.equal(result.classLabel, "Vegetation loss");
  assert.deepEqual(result.patch, {
    id: "ev_abc12345",
    areaHa: 12.5,
    confidence: "high",
    confidencePct: 88,
    evidence: "Likely harvest / crop cycle",
  });
});

test("inspectChangeAt: change pixel with no containing patch → patch null", () => {
  const input = gridRef();
  input.grid[10] = CLASS.waterGain;
  const result = inspectChangeAt(input, [], 73, 25);
  assert.equal(result.kind, "change");
  assert.equal(result.classLabel, "Water gain");
  assert.equal(result.patch, null);
});

test("inspectChangeAt: masked pixel → masked; 255 inside bbox → outside", () => {
  const masked = gridRef(CLASS.masked);
  const maskedResult = inspectChangeAt(masked, [], 73, 25);
  assert.equal(maskedResult.kind, "masked");
  assert.equal(maskedResult.classLabel, "Masked (clouds / no data)");

  const outside = gridRef(CLASS.outside);
  const outsideResult = inspectChangeAt(outside, [], 73, 25);
  assert.equal(outsideResult.kind, "outside");
  assert.equal(outsideResult.classCode, CLASS.outside);
});

test("inspectChangeAt: point outside the analysed bbox short-circuits (empty grid is fine)", () => {
  const empty: ClassGridRef = { grid: new Uint8Array(0), width: 4, height: 4, bbox: [72, 24, 74, 26] };
  const result = inspectChangeAt(empty, [patchSquare], 71, 25);
  assert.equal(result.kind, "outside");
  assert.equal(result.patch, null);
});

test("inspectChangeAt: grid indices clamp at every edge", () => {
  const input = gridRef();
  input.grid[3] = CLASS.waterGain; // row 0, col 3 — exact east edge (74, 26)
  input.grid[3 * 4 + 0] = CLASS.bareBuilt; // row 3, col 0 — exact south-west corner
  assert.equal(inspectChangeAt(input, [], 74, 26).classCode, CLASS.waterGain);
  assert.equal(inspectChangeAt(input, [], 72, 24).classCode, CLASS.bareBuilt);
});

test("findPatchAt: bbox rejects before geometry; geometry decides inside", () => {
  const far = {
    ...patchSquare,
    properties: { ...patchSquare.properties, bbox: [80, 30, 81, 31] },
  };
  // bbox says "somewhere else" even though the polygon would cover the point.
  assert.equal(findPatchAt([far as GeoJSON.Feature], 73, 25), null);

  // Feature without a bbox still falls through to point-in-polygon.
  const noBbox = {
    ...patchSquare,
    properties: { ...patchSquare.properties, bbox: undefined },
  };
  const hit = findPatchAt([noBbox as GeoJSON.Feature], 73.1, 24.9);
  assert.equal(hit?.id, "ev_abc12345");
  assert.equal(findPatchAt([noBbox as GeoJSON.Feature], 76, 25), null);
});

test("findPatchAt: missing/short patch properties degrade to safe defaults", () => {
  const bare: GeoJSON.Feature = {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [72, 24],
          [74, 24],
          [74, 26],
          [72, 26],
          [72, 24],
        ],
      ],
    },
    properties: {},
  };
  const hit = findPatchAt([bare], 73, 25);
  assert.deepEqual(hit, {
    id: "",
    areaHa: 0,
    confidence: null,
    confidencePct: null,
    evidence: null,
  });
});
