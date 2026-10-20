import assert from "node:assert/strict";
import test from "node:test";
import {
  DOWNLOAD_FORMAT_LABELS,
  MAX_DOWNLOAD_PX,
  isGeoTiff,
  nativeDownloadSize,
  planDownload,
  type DownloadTarget,
} from "../lib/downloads"; // relative: tsc leaves "@/…" aliases in emitted JS

function boxPolygon(bbox: [number, number, number, number]): GeoJSON.Polygon {
  const [west, south, east, north] = bbox;
  return {
    type: "Polygon",
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

function target(name: string, bbox: [number, number, number, number]): DownloadTarget {
  return { name, bbox, geometry: boxPolygon(bbox) };
}

test("nativeDownloadSize maps a WGS84 bbox to 10 m pixels", () => {
  const size = nativeDownloadSize([75.5, 26.5, 76.0, 27.0]);
  // 0.5° of latitude is ~55.3 km; 0.5° of longitude at 26.75° N is ~49.7 km.
  assert.ok(size.height > 5450 && size.height < 5600, `height=${size.height}`);
  assert.ok(size.width > 4900 && size.width < 5050, `width=${size.width}`);
});

test("areas under the cap download at native 10 m with no confirmation", () => {
  const plan = planDownload(target("Small patch", [75.75, 26.99, 75.77, 27.01]));
  assert.equal(plan.reduced, false);
  assert.equal(plan.metersPerPixel, 10);
  assert.deepEqual(plan.size, plan.native);
  assert.ok(Math.max(plan.size.width, plan.size.height) <= MAX_DOWNLOAD_PX);
});

test("district-sized areas are scaled to the cap and marked reduced", () => {
  const plan = planDownload(target("Jaipur", [74.9, 26.5, 77.0, 27.9]));
  assert.equal(plan.reduced, true);
  assert.ok(plan.native.width > MAX_DOWNLOAD_PX && plan.native.height > MAX_DOWNLOAD_PX);
  assert.equal(Math.max(plan.size.width, plan.size.height), MAX_DOWNLOAD_PX);
  assert.ok(plan.size.width <= MAX_DOWNLOAD_PX && plan.size.height <= MAX_DOWNLOAD_PX);
  assert.ok(plan.metersPerPixel > 10, `mpp=${plan.metersPerPixel}`);
  assert.equal(
    plan.metersPerPixel,
    (Math.max(plan.native.width, plan.native.height) * 10) / MAX_DOWNLOAD_PX,
  );
});

test("format helpers describe what each download produces", () => {
  assert.equal(isGeoTiff("png"), false);
  assert.equal(isGeoTiff("tiff"), true);
  assert.equal(isGeoTiff("analysis"), true);
  assert.equal(DOWNLOAD_FORMAT_LABELS.png, "PNG preview");
  assert.equal(DOWNLOAD_FORMAT_LABELS.tiff, "visual GeoTIFF");
  assert.equal(DOWNLOAD_FORMAT_LABELS.analysis, "analysis GeoTIFF");
});
