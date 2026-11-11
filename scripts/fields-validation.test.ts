import "./alias-hook"; // must be first: installs the "@/." resolver before the graph loads
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FIELD_CLASS_NAMES,
  FIELD_NONE,
  boundaryMask,
  boundaryMcc,
  collapseFieldMask,
  dilateMask,
  fieldMaskMetrics,
  matthewsCorrelation,
  patternClassIndex,
  validateFieldsCase,
  type FieldsCase,
} from "../validation/fields";
import type { GeoJsonFeature, GeoJsonFeatureCollection } from "../validation/engine";
import { PATTERN_CLASSES } from "../lib/fields/config";

/**
 * Phase 4: the fields validation harness must score field geometry and
 * cropping-pattern classes correctly — perfect layers score perfect, a
 * geometry shift lowers boundary MCC, a class swap lands off-diagonal, and a
 * missed/spurious field shows up as FN/FP rather than disappearing.
 */

const SOURCE_ROOT = path.resolve(__dirname, "..", "..");

function loadCase(name: string): FieldsCase {
  const read = (file: string): GeoJsonFeatureCollection =>
    JSON.parse(
      readFileSync(path.join(SOURCE_ROOT, "validation", "fixtures", file), "utf8"),
    ) as GeoJsonFeatureCollection;
  return {
    name,
    reference: read(`${name}.reference.geojson`),
    prediction: read(`${name}.prediction.geojson`),
  };
}

function feat(props: Record<string, unknown>): GeoJsonFeature {
  return { type: "Feature", properties: props, geometry: null };
}

test("patternClassIndex: known, missing and unknown cls", () => {
  assert.equal(patternClassIndex(feat({ cls: "kharif-only" })), PATTERN_CLASSES.indexOf("kharif-only"));
  assert.equal(
    patternClassIndex(feat({ cls: " RABI-ONLY " })),
    PATTERN_CLASSES.indexOf("rabi-only"),
    "trim + case-insensitive",
  );
  assert.equal(
    patternClassIndex(feat({})),
    PATTERN_CLASSES.indexOf("unclassified"),
    "missing cls → unclassified (boundary-only labels)",
  );
  assert.equal(
    patternClassIndex(feat({ cls: "maize" })),
    null,
    "unknown cls → feature dropped",
  );
});

test("boundaryMask: a filled block flags only its edge ring", () => {
  const width = 5;
  const height = 5;
  const mask = new Uint8Array(width * height);
  // 3×3 block at rows/cols 1..3.
  for (let r = 1; r <= 3; r += 1) {
    for (let c = 1; c <= 3; c += 1) mask[r * width + c] = 1;
  }
  const boundary = boundaryMask(mask, width, height);
  assert.equal(boundary[2 * width + 2], 0, "centre is interior");
  assert.equal(boundary[1 * width + 1], 1, "corner of the block is boundary");
  assert.equal(boundary[1 * width + 2], 1, "edge of the block is boundary");
  assert.equal(boundary[0], 0, "empty pixel stays empty");
  let count = 0;
  for (const v of boundary) count += v;
  assert.equal(count, 8, "a 3×3 block has 8 boundary pixels");
});

test("dilateMask: radius grows the mask, radius 0 is a no-op", () => {
  const width = 5;
  const height = 5;
  const mask = new Uint8Array(width * height);
  mask[2 * width + 2] = 1;
  assert.deepEqual(Array.from(dilateMask(mask, width, height, 0)), Array.from(mask));
  const r1 = dilateMask(mask, width, height, 1);
  assert.equal(r1[1 * width + 1], 1, "8-neighbour dilation reaches the diagonal");
  assert.equal(r1[2 * width + 3], 1, "…and one pixel out along the row");
  assert.equal(r1[2 * width + 4], 0, "but not two pixels out at radius 1");
  assert.equal(r1[0], 0, "far corner untouched at radius 1");
  const r2 = dilateMask(mask, width, height, 2);
  assert.equal(r2[0], 1, "radius 2 reaches the far corner");
});

test("matthewsCorrelation: perfect, inverted and degenerate cases", () => {
  assert.equal(matthewsCorrelation(10, 0, 0, 10), 1);
  assert.equal(matthewsCorrelation(0, 10, 10, 0), -1);
  assert.ok(Math.abs((matthewsCorrelation(5, 5, 5, 5) as number) - 0) < 1e-12);
  assert.equal(matthewsCorrelation(0, 0, 0, 0), null, "empty grid → undefined");
  assert.equal(matthewsCorrelation(5, 0, 0, 0), null, "no negatives → undefined");
});

test("collapseFieldMask + fieldMaskMetrics: class confusion folds to field/no_field", () => {
  const n = FIELD_NONE + 1;
  const confusion = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  confusion[0][0] = 6; // kharif predicted kharif
  confusion[0][FIELD_NONE] = 2; // kharif missed
  confusion[FIELD_NONE][1] = 3; // spurious rabi
  confusion[FIELD_NONE][FIELD_NONE] = 100; // correct background
  const { tp, fp, fn, tn } = collapseFieldMask(confusion);
  assert.deepEqual({ tp, fp, fn, tn }, { tp: 6, fp: 3, fn: 2, tn: 100 });
  const mask = fieldMaskMetrics(confusion);
  assert.equal(mask.iou, 6 / (6 + 3 + 2));
  assert.equal(mask.precision, 6 / 9);
  assert.equal(mask.recall, 6 / 8);
});

test("aligned fixture: every metric is perfect", () => {
  const report = validateFieldsCase(loadCase("fields-aligned"), 200, 2);
  assert.equal(report.mask.iou, 1, "identical layers → IoU 1");
  assert.equal(report.mask.precision, 1);
  assert.equal(report.mask.recall, 1);
  assert.equal(report.mask.f1, 1);
  assert.equal(report.boundaryMcc, 1, "identical boundaries → MCC 1");
  assert.equal(report.macroF1, 1, "every class scores 1");
  const kharif = report.classMetrics[PATTERN_CLASSES.indexOf("kharif-only")];
  assert.ok(kharif.tp > 0 && kharif.fp === 0 && kharif.fn === 0);
});

test("shifted-swap fixture: geometry shift lowers MCC, swap lands off-diagonal", () => {
  const report = validateFieldsCase(loadCase("fields-shifted-swap"), 200, 2);
  assert.ok(
    (report.boundaryMcc as number) < 1 && (report.boundaryMcc as number) > 0,
    `shifted boundaries must score between 0 and 1 (got ${report.boundaryMcc})`,
  );
  assert.ok(
    (report.mask.iou as number) < 1 && (report.mask.iou as number) > 0.5,
    `50 m shift on 400 m fields keeps IoU > 0.5 (got ${report.mask.iou})`,
  );
  const kharif = PATTERN_CLASSES.indexOf("kharif-only");
  const rabi = PATTERN_CLASSES.indexOf("rabi-only");
  assert.ok(
    report.confusion[kharif][rabi] > 0,
    "reference kharif predicted as rabi (the swap) is off-diagonal",
  );
  assert.ok(
    report.confusion[rabi][kharif] > 0,
    "reference rabi predicted as kharif (the swap) is off-diagonal",
  );
  assert.ok(
    (report.macroF1 as number) < 1,
    "swapped classes must pull macro F1 below 1",
  );
});

test("missed fixture: a missing field is FN, a spurious one is FP", () => {
  const report = validateFieldsCase(loadCase("fields-missed"), 200, 2);
  assert.ok(report.mask.fn > 0, "missed field D counts as false negatives");
  assert.ok(report.mask.fp > 0, "spurious field E counts as false positives");
  assert.ok((report.mask.recall as number) < 1, "recall below 1 with a missed field");
  assert.ok((report.mask.precision as number) < 1, "precision below 1 with a spurious field");
  const fallow = PATTERN_CLASSES.indexOf("fallow");
  const evergreen = PATTERN_CLASSES.indexOf("evergreen");
  assert.ok(
    report.confusion[fallow][FIELD_NONE] > 0,
    "fallow pixels with no prediction land in the no_field column",
  );
  assert.ok(
    report.confusion[FIELD_NONE][evergreen] > 0,
    "spurious evergreen pixels land in the no_field row",
  );
});

test("FIELD_CLASS_NAMES matches the pattern classes plus no_field", () => {
  assert.equal(FIELD_CLASS_NAMES.length, PATTERN_CLASSES.length + 1);
  assert.equal(FIELD_CLASS_NAMES[FIELD_NONE], "no_field");
  assert.deepEqual([...FIELD_CLASS_NAMES].slice(0, -1), [...PATTERN_CLASSES]);
});
