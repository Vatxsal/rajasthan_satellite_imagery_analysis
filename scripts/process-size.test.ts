import "./alias-hook"; // must be first: installs the "@/…" resolver before the graph loads

import assert from "node:assert/strict";
import test from "node:test";
import {
  assertProcessOutputSize,
  computeOutputSize,
  PROCESS_MAX_OUTPUT_PX,
} from "../lib/cdse/geometry";
import { nativeLongSidePx } from "../lib/analysis/grid";
import { DETAIL_BLOCK_PX, DETAIL_OVERLAP_PX, planDetail, screeningSize } from "../lib/analysis/detail";
import { prepareCompare } from "../lib/analysis/process";

/**
 * Regression: the Smart screening pass asked Copernicus for a 4096-px-wide
 * render (COMMON_BAD_PAYLOAD, "output->width must be less than or equal to
 * 2500") because its cap exceeded the Process API's documented 2500×2500
 * output limit. Every Process-feeding size computation must now stay within
 * PROCESS_MAX_OUTPUT_PX — this matrix prints and asserts them all.
 */

/** Jaipur-like district: ~1.9° E-W (~168 km) × ~0.9° N-S (~100 km). */
const JAIPUR: [number, number, number, number] = [75.0, 26.5, 76.9, 27.4];
/** Small tehsil: ~0.2° (~20 km) per side. */
const TEHSIL: [number, number, number, number] = [74.95, 26.55, 75.15, 26.75];

function rectGeometry(bbox: [number, number, number, number]): GeoJSON.Polygon {
  const [w, s, e, n] = bbox;
  return {
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

function quickSize(bbox: [number, number, number, number], maxPx: number): { width: number; height: number } {
  const prep = prepareCompare({
    geometry: rectGeometry(bbox),
    dateA: "2026-05-01",
    dateB: "2026-05-20",
    areaName: "Fixture",
    areaLevel: "tehsil",
    areaId: "size-fixture",
    sensitivity: "medium",
    maxPx,
  });
  return { width: prep.width, height: prep.height };
}

function assertWithinLimit(
  label: string,
  size: { width: number; height: number },
): void {
  console.log(`  ${label}: ${size.width}×${size.height} px (limit ${PROCESS_MAX_OUTPUT_PX})`);
  assert.ok(
    size.width >= 1 && size.width <= PROCESS_MAX_OUTPUT_PX,
    `${label} width ${size.width} exceeds the Process API limit`,
  );
  assert.ok(
    size.height >= 1 && size.height <= PROCESS_MAX_OUTPUT_PX,
    `${label} height ${size.height} exceeds the Process API limit`,
  );
}

test("the documented Process API limit is a single named constant", () => {
  // CDSE docs (notebook-samples/sentinelhub): "For a Process API request,
  // the limit is 2500*2500 pixels" — confirmed by the upstream error
  // "output->width must be less than or equal to 2500".
  assert.equal(PROCESS_MAX_OUTPUT_PX, 2500);
  // assertProcessOutputSize is the last line before any POST.
  assert.doesNotThrow(() => assertProcessOutputSize(2500, 2500));
  assert.doesNotThrow(() => assertProcessOutputSize(160, 160));
  for (const bad of [
    [4096, 800],
    [2500, 2501],
    [0, 100],
    [-1, 100],
  ] as const) {
    assert.throws(
      () => assertProcessOutputSize(bad[0], bad[1]),
      (error: unknown) => {
        const err = error as { code?: string; message?: string };
        return (
          err.code === "PROCESS_OUTPUT_TOO_LARGE" &&
          /not sent/.test(err.message ?? "")
        );
      },
      `oversized ${bad[0]}×${bad[1]} must refuse before sending`,
    );
  }
});

test("district AOI (Jaipur-scale): Quick / Smart / Detailed all stay within the limit", () => {
  const native = nativeLongSidePx(JAIPUR);
  console.log(`Jaipur-like district: native long side = ${Math.round(native)} px (10 m)`);
  assert.ok(native > 15_000, "fixture must be district-scale");

  console.log("Quick (COMPARE_MAX_PX default 1500):");
  assertWithinLimit("  quick grid", quickSize(JAIPUR, 1500));

  // The regression: this was capped at 4096 before the fix and Copernicus
  // answered 400 COMMON_BAD_PAYLOAD ("output->width … 4096").
  console.log("Smart screening:");
  const smart = screeningSize(JAIPUR);
  assertWithinLimit("  screening raster", smart);
  assert.equal(smart.width, PROCESS_MAX_OUTPUT_PX, "a district clamps the screening to the cap");
  // Coarsening is the fix: the effective screening resolution is reported
  // to the UI (estimate card) instead of failing.
  const effectiveM = (native * 10) / smart.width;
  console.log(`  effective screening resolution ≈ ${Math.round(effectiveM)} m`);
  assert.ok(effectiveM > 40, "a district screens coarser than the 40 m target");

  console.log("Detailed blocks:");
  const plan = planDetail(JAIPUR);
  console.log(`  ${plan.blocks.length} blocks of ≤ ${DETAIL_BLOCK_PX + 2 * DETAIL_OVERLAP_PX} px`);
  for (const block of plan.blocks) {
    assert.ok(block.width <= DETAIL_BLOCK_PX + 2 * DETAIL_OVERLAP_PX);
    assert.ok(block.height <= DETAIL_BLOCK_PX + 2 * DETAIL_OVERLAP_PX);
  }
  assert.ok(plan.blocks.length > 100, "district lattice is many blocks");
  // Block rasters feed the Process API one at a time — all within the limit.
  for (const block of plan.blocks.slice(0, 12)) {
    assert.doesNotThrow(() => assertProcessOutputSize(block.width, block.height));
  }
});

test("small tehsil AOI: Quick / Smart / Detailed all stay within the limit", () => {
  const native = nativeLongSidePx(TEHSIL);
  console.log(`Small tehsil: native long side = ${Math.round(native)} px (10 m)`);
  assert.ok(native > 1500 && native < 2500, "fixture must be tehsil-scale");

  console.log("Quick (COMPARE_MAX_PX default 1500):");
  assertWithinLimit("  quick grid", quickSize(TEHSIL, 1500));

  console.log("Smart screening:");
  assertWithinLimit("  screening raster", screeningSize(TEHSIL));

  console.log("Detailed blocks:");
  const plan = planDetail(TEHSIL);
  console.log(`  ${plan.blocks.length} blocks`);
  assert.ok(plan.blocks.length < 20, "tehsil lattice is a handful of blocks");
  for (const block of plan.blocks) {
    assert.doesNotThrow(() => assertProcessOutputSize(block.width, block.height));
  }
});

test("prepareCompare clamps an oversized COMPARE_MAX_PX env override", () => {
  // An operator can set COMPARE_MAX_PX=4096 — the grid must still respect
  // the Process API limit (the env schema allows up to 4096).
  const clamped = quickSize(JAIPUR, 4096);
  console.log(`  COMPARE_MAX_PX=4096 → grid ${clamped.width}×${clamped.height}`);
  assert.equal(clamped.width, PROCESS_MAX_OUTPUT_PX);
  assert.ok(clamped.height <= PROCESS_MAX_OUTPUT_PX);
});

test("prepareCompare refuses an explicit oversized grid before any fetch", () => {
  assert.throws(
    () =>
      prepareCompare({
        geometry: rectGeometry(JAIPUR),
        dateA: "2026-05-01",
        dateB: "2026-05-20",
        areaName: "Fixture",
        areaLevel: "tehsil",
        areaId: "size-fixture",
        sensitivity: "medium",
        outputSize: { width: 4096, height: 800 },
      }),
    (error: unknown) => (error as { code?: string }).code === "PROCESS_OUTPUT_TOO_LARGE",
    "explicit outputSize beyond the limit must fail locally, not upstream",
  );
});

test("raw computeOutputSize documents why callers must clamp", () => {
  // Unclamped, a 4096 target would exceed the limit — this is the shape the
  // old screening produced (and Copernicus rejected).
  const raw = computeOutputSize(JAIPUR, 4096);
  assert.equal(raw.width, 4096);
  assert.throws(() => assertProcessOutputSize(raw.width, raw.height));
});
