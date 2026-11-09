import assert from "node:assert/strict";
import test from "node:test";
import { featureClass, type GeoJsonFeature } from "../validation/engine";

/**
 * Phase 6: the harness must recognise the fused engine's full bare-agri
 * sub-label text ("Bare soil on cropland (likely harvest / tillage)") as
 * bare_agri, not just the short alias — otherwise fused predictions of a
 * harvest event silently score as builtup_increase against real references.
 */

function feat(props: Record<string, unknown>): GeoJsonFeature {
  return { type: "Feature", properties: props, geometry: null };
}

test("featureClass: bare/built sub-labels — engine text maps to bare_agri", () => {
  assert.equal(
    featureClass(feat({ classCode: 3, subLabel: "Bare soil on cropland (likely harvest / tillage)" })),
    "bare_agri",
    "SUB_LABELS[bareBuiltAgriculture] text must score as bare_agri",
  );
  assert.equal(
    featureClass(feat({ cls: "builtup_increase", sub_label: "bare_agri" })),
    "bare_agri",
    "short alias (sub_label)",
  );
  assert.equal(
    featureClass(feat({ classCode: 3, sub: "agri_bare" })),
    "bare_agri",
    "reversed alias (sub)",
  );
  assert.equal(
    featureClass(feat({ classLabel: "Built-up increase", subLabel: "Bare soil on cropland (likely harvest / tillage)" })),
    "bare_agri",
    "classLabel base + engine sub text",
  );
});

test("featureClass: other bare/built sub-labels stay builtup_increase", () => {
  assert.equal(featureClass(feat({ classCode: 3 })), "builtup_increase", "no sub-label");
  assert.equal(
    featureClass(feat({ classCode: 3, subLabel: "Built-up / construction signal" })),
    "builtup_increase",
  );
  assert.equal(
    featureClass(feat({ classCode: 3, subLabel: "Bare surface increase" })),
    "builtup_increase",
  );
  assert.equal(
    featureClass(feat({ classCode: 3, subLabel: "Possible built-up" })),
    "builtup_increase",
  );
});

test("featureClass: veg sub-labels are never remapped to bare_agri", () => {
  // "Likely harvest / crop cycle" contains harvest — but only builtup_increase
  // predictions are sub-label checked, so veg_loss stays veg_loss.
  assert.equal(
    featureClass(feat({ classCode: 2, subLabel: "Likely harvest / crop cycle" })),
    "veg_loss",
  );
  assert.equal(
    featureClass(feat({ cls: "veg_loss", subLabel: "Likely harvest / crop cycle" })),
    "veg_loss",
  );
  assert.equal(featureClass(feat({ cls: "water_gain" })), "water_gain");
  assert.equal(featureClass(feat({ cls: "bare_agri" })), "bare_agri", "cls alias wins as-is");
});
