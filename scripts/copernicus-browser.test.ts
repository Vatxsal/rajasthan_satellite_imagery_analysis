import assert from "node:assert/strict";
import test from "node:test";
import {
  COPERNICUS_BROWSER_BASE,
  DEFAULT_THEME_ID,
  S2_L2A_DATASET_ID,
  buildCopernicusBrowserUrl,
  centerOfBBox,
  layerIdFor,
  zoomForBBox,
} from "../lib/copernicusBrowser"; // relative: tsc leaves "@/…" aliases in emitted JS

/** A real tile-ish bbox over Jaipur. */
const JAIPUR: [number, number, number, number] = [75.4, 26.7, 76.2, 27.1];
const DATE = "2026-09-06";

test("builds the documented share URL", () => {
  const url = buildCopernicusBrowserUrl({ bbox: JAIPUR, date: DATE });
  assert.ok(url.startsWith(COPERNICUS_BROWSER_BASE), `got ${url}`);

  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, COPERNICUS_BROWSER_BASE.replace(/\/$/, "") + "/");
  assert.equal(parsed.searchParams.get("datasetId"), S2_L2A_DATASET_ID);
  assert.equal(parsed.searchParams.get("themeId"), DEFAULT_THEME_ID);
  assert.equal(parsed.searchParams.get("dateMode"), "SINGLE");

  const center = centerOfBBox(JAIPUR);
  assert.equal(Number(parsed.searchParams.get("lat")), Number(center.lat.toFixed(6)));
  assert.equal(Number(parsed.searchParams.get("lng")), Number(center.lng.toFixed(6)));
  assert.equal(typeof Number(parsed.searchParams.get("zoom")), "number");
});

test("fromTime/toTime cover the whole UTC day", () => {
  const parsed = new URL(buildCopernicusBrowserUrl({ bbox: JAIPUR, date: DATE }));
  assert.equal(parsed.searchParams.get("fromTime"), "2026-09-06T00:00:00.000Z");
  assert.equal(parsed.searchParams.get("toTime"), "2026-09-06T23:59:59.999Z");

  // Times are percent-encoded the way the real browser share links are.
  const raw = buildCopernicusBrowserUrl({ bbox: JAIPUR, date: DATE });
  assert.ok(raw.includes("T00%3A00%3A00.000Z"), raw);
  assert.ok(raw.includes("T23%3A59%3A59.999Z"), raw);
});

test("layerId follows the selected composite", () => {
  assert.equal(layerIdFor("true-color"), "1_TRUE_COLOR");
  assert.equal(layerIdFor("false-color"), "2_FALSE_COLOR");
  assert.equal(layerIdFor("ndvi"), "NDVI");

  assert.equal(
    new URL(buildCopernicusBrowserUrl({ bbox: JAIPUR, date: DATE, composite: "false-color" })).searchParams.get("layerId"),
    "2_FALSE_COLOR",
  );
  assert.equal(
    new URL(buildCopernicusBrowserUrl({ bbox: JAIPUR, date: DATE, composite: "ndvi" })).searchParams.get("layerId"),
    "NDVI",
  );
  // Default is true colour when nothing is passed.
  assert.equal(
    new URL(buildCopernicusBrowserUrl({ bbox: JAIPUR, date: DATE })).searchParams.get("layerId"),
    "1_TRUE_COLOR",
  );
});

test("explicit layerId / datasetId / themeId / zoom win over the derived ones", () => {
  const parsed = new URL(
    buildCopernicusBrowserUrl({
      bbox: JAIPUR,
      date: DATE,
      composite: "ndvi",
      layerId: "SCENE-CLASSIFICATION",
      datasetId: "S2_L1C_CDAS",
      themeId: "WILDFIRES",
      zoom: 12,
      lat: 1.5,
      lng: 2.5,
    }),
  );
  assert.equal(parsed.searchParams.get("layerId"), "SCENE-CLASSIFICATION");
  assert.equal(parsed.searchParams.get("datasetId"), "S2_L1C_CDAS");
  assert.equal(parsed.searchParams.get("themeId"), "WILDFIRES");
  assert.equal(parsed.searchParams.get("zoom"), "12");
  assert.equal(parsed.searchParams.get("lat"), "1.5");
  assert.equal(parsed.searchParams.get("lng"), "2.5");
});

test("every required parameter is present exactly once", () => {
  const parsed = new URL(buildCopernicusBrowserUrl({ bbox: JAIPUR, date: DATE }));
  for (const key of ["datasetId", "fromTime", "toTime", "lat", "lng", "zoom", "layerId", "themeId"]) {
    assert.equal(parsed.searchParams.getAll(key).length, 1, `${key} count`);
    assert.notEqual(parsed.searchParams.get(key), "", `${key} empty`);
  }
});

test("zoom fits the bbox and stays in a sane range", () => {
  const district = zoomForBBox([73.5, 25.5, 77.5, 28.5]);
  const tehsil = zoomForBBox([75.7, 26.85, 75.9, 26.95]);
  assert.ok(district >= 1 && district <= 18, String(district));
  assert.ok(tehsil >= 1 && tehsil <= 18, String(tehsil));
  assert.ok(tehsil > district, `tehsil ${tehsil} should be zoomed further than district ${district}`);

  // Degenerate bbox must not produce NaN or ±Infinity.
  assert.ok(Number.isFinite(zoomForBBox([75, 27, 75, 27])));
});

test("centre is the plain bbox midpoint", () => {
  const center = centerOfBBox([75.4, 26.7, 76.2, 27.1]);
  assert.ok(Math.abs(center.lat - 26.9) < 1e-9, String(center.lat));
  assert.ok(Math.abs(center.lng - 75.8) < 1e-9, String(center.lng));
});
