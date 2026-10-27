import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASS,
  classLabel,
  scaledThresholds,
} from "../lib/analysis/config";
import { classifyChange, combineValidity, dilateInvalid } from "../lib/analysis/classify";
import { labelPatches, majorityFilter, minPatchPixels } from "../lib/analysis/filter";
import { makeAnalysisGrid } from "../lib/analysis/grid";
import { rasterizeAreaMask, rasterizeZones } from "../lib/analysis/mask";
import { computeStats } from "../lib/analysis/stats";
import type { IndexRasters } from "../lib/analysis/types";

const W = 60;
const H = 60;
const N = W * H;

/** 60×60 grid with ~10 m pixels near 26°N (1 px ≈ 0.01 ha). */
function testGrid() {
  const lat0 = 26;
  const pxLat = 10 / 110_574;
  const pxLon = 10 / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  return makeAnalysisGrid([74, lat0, 74 + W * pxLon, lat0 + H * pxLat], W, H);
}

function fill(value: number): Float32Array {
  return new Float32Array(N).fill(value);
}

function ones(): Uint8Array {
  return new Uint8Array(N).fill(1);
}

function baseIndices(): IndexRasters {
  return { ndvi: fill(0.6), mndwi: fill(-0.1), ndbi: fill(-0.05) };
}

function setSquare(
  raster: Float32Array | Uint8Array,
  row0: number,
  col0: number,
  size: number,
  value: number,
): void {
  for (let r = row0; r < row0 + size; r++) {
    for (let c = col0; c < col0 + size; c++) raster[r * W + c] = value;
  }
}

test("identical dates → zero change, negligible result", () => {
  const grid = testGrid();
  const inside = ones();
  const a = baseIndices();
  const b = baseIndices();
  const valid = dilateInvalid(combineValidity(ones(), ones(), inside), W, H);
  let classGrid = classifyChange(a, b, valid, inside, scaledThresholds("medium"));
  classGrid = majorityFilter(classGrid, valid, W, H);
  const { labels } = labelPatches(classGrid, W, H, minPatchPixels(0.2, grid.metersX, grid.metersY));
  const stats = computeStats({ classGrid, labels, grid });

  assert.equal(stats.negligible, true);
  assert.equal(stats.changedHa, 0);
  assert.equal(stats.validPct, 100);
  assert.equal(stats.hotspots.length, 0);
});

test("planted vegetation-loss block → exact class and area (~4 ha)", () => {
  const grid = testGrid();
  const inside = ones();
  const a = baseIndices();
  const b = baseIndices();
  setSquare(b.ndvi, 20, 20, 20, 0.2); // 20×20 block = 400 px ≈ 4 ha planted loss

  const valid = dilateInvalid(combineValidity(ones(), ones(), inside), W, H);
  let classGrid = classifyChange(a, b, valid, inside, scaledThresholds("medium"));
  assert.equal(classGrid[20 * W + 20], CLASS.vegLoss, "planted block must classify as veg loss");

  classGrid = majorityFilter(classGrid, valid, W, H);
  const { labels } = labelPatches(classGrid, W, H, minPatchPixels(0.2, grid.metersX, grid.metersY));
  const stats = computeStats({ classGrid, labels, grid });

  assert.equal(stats.negligible, false);
  const plantedHa = (400 * grid.metersX * grid.metersY) / 10_000;
  // The 3×3 majority filter flips the block's 4 corner pixels to no-change
  // (4-of-9 votes), so the surviving patch is ~1 % under the planted area.
  assert.ok(
    Math.abs(stats.changedHa - plantedHa) / plantedHa < 0.02,
    `changedHa=${stats.changedHa} expected≈${plantedHa}`,
  );
  const vegLoss = stats.classes.find((c) => c.code === CLASS.vegLoss)!;
  assert.ok(vegLoss.pixels >= 390 && vegLoss.pixels <= 400, `pixels=${vegLoss.pixels}`);
  assert.equal(stats.hotspots.length, 1, "the block is one connected patch");
  assert.equal(stats.hotspots[0].classCode, CLASS.vegLoss);
  assert.equal(stats.hotspots[0].tehsilName, null, "no zones requested → no tehsil attribution");
  assert.equal(classLabel(CLASS.vegLoss), "Vegetation loss");
});

test("clouds (invalid pixels) → masked, excluded from change; 1-px halo dilated", () => {
  const grid = testGrid();
  const inside = ones();
  const validB = ones();
  setSquare(validB, 30, 30, 10, 0); // cloud in date B
  const a = baseIndices();
  const b = baseIndices();
  setSquare(b.ndvi, 30, 30, 10, 0.1); // would be veg loss if valid

  const valid = dilateInvalid(combineValidity(ones(), validB, inside), W, H);
  assert.equal(valid[35 * W + 35], 0, "cloud core invalid");
  assert.equal(valid[29 * W + 35], 0, "pixel adjacent to cloud dilated away");

  let classGrid = classifyChange(a, b, valid, inside, scaledThresholds("medium"));
  classGrid = majorityFilter(classGrid, valid, W, H);
  const { labels } = labelPatches(classGrid, W, H, minPatchPixels(0.2, grid.metersX, grid.metersY));
  const stats = computeStats({ classGrid, labels, grid });

  assert.equal(classGrid[35 * W + 35], CLASS.masked);
  assert.equal(stats.changedHa, 0, "no change may come out of masked pixels");
  const masked = stats.classes.find((c) => c.code === CLASS.masked)!;
  assert.ok(masked.pixels >= 100, "at least the cloud core is masked");
  assert.ok(stats.validPct < 100 && stats.validPct > 80);
});

test("sub-MMU patch removed by the 0.2 ha cutoff; majority kills isolated noise", () => {
  const grid = testGrid();
  const inside = ones();
  const a = baseIndices();
  const b = baseIndices();
  setSquare(b.ndvi, 10, 10, 3, 0.2); // 3×3 = 9 px ≈ 0.09 ha < 0.2 ha MMU

  const valid = dilateInvalid(combineValidity(ones(), ones(), inside), W, H);
  let classGrid = classifyChange(a, b, valid, inside, scaledThresholds("medium"));
  assert.equal(classGrid[11 * W + 11], CLASS.vegLoss, "raw classification sees the patch");

  classGrid = majorityFilter(classGrid, valid, W, H);
  const { removedCount, keptCount } = labelPatches(
    classGrid,
    W,
    H,
    minPatchPixels(0.2, grid.metersX, grid.metersY),
  );

  assert.equal(classGrid[11 * W + 11], CLASS.noChange, "MMU removed the sub-threshold patch");
  assert.equal(removedCount, 1, "exactly one patch was dropped");
  assert.equal(keptCount, 0);

  // Majority filter: isolated single change pixel in a no-change sea → no-change.
  const isolated = new Uint8Array(N); // all no-change
  isolated[30 * W + 30] = CLASS.vegLoss;
  const smoothed = majorityFilter(isolated, ones(), W, H);
  assert.equal(smoothed[30 * W + 30], CLASS.noChange);
  // Solid 5×5 block survives majority untouched.
  const block = new Uint8Array(N); // all no-change
  setSquare(block, 10, 10, 5, CLASS.vegLoss);
  const smoothedBlock = majorityFilter(block, ones(), W, H);
  assert.equal(smoothedBlock[12 * W + 12], CLASS.vegLoss);
});

test("classification precedence: water gain > water loss > veg loss > bare/built", () => {
  const inside = ones();
  const valid = ones();
  const t = scaledThresholds("medium");

  // Water gain must beat simultaneous veg loss.
  const a: IndexRasters = { ndvi: fill(0.6), mndwi: fill(-0.1), ndbi: fill(-0.05) };
  const waterGainB: IndexRasters = { ndvi: fill(0.1), mndwi: fill(0.2), ndbi: fill(-0.1) };
  assert.equal(classifyChange(a, waterGainB, valid, inside, t)[0], CLASS.waterGain);

  // Water loss must beat simultaneous veg loss.
  const waterLossA: IndexRasters = { ndvi: fill(0.6), mndwi: fill(0.2), ndbi: fill(-0.05) };
  const waterLossB: IndexRasters = { ndvi: fill(0.3), mndwi: fill(-0.1), ndbi: fill(0.0) };
  assert.equal(classifyChange(waterLossA, waterLossB, valid, inside, t)[0], CLASS.waterLoss);

  // Bare/built-up requires NDBI rise + green-down + non-water.
  const bareB: IndexRasters = { ndvi: fill(0.5), mndwi: fill(-0.1), ndbi: fill(0.1) };
  assert.equal(classifyChange(a, bareB, valid, inside, t)[0], CLASS.bareBuilt);

  // Inside polygon beats everything: outside → CLASS.outside.
  const allOut = new Uint8Array(N); // inside = 0
  assert.equal(classifyChange(a, waterGainB, valid, allOut, t)[0], CLASS.outside);
});

test("grid geometry and area conversion (ha) are right", () => {
  const grid = testGrid();
  assert.ok(Math.abs(grid.metersPerPixel - 10) < 0.1, `metersPerPixel=${grid.metersPerPixel}`);
  assert.ok(Math.abs(grid.metersX - 10) < 0.1);
  assert.ok(Math.abs(grid.metersY - 10) < 0.1);

  const inside = ones();
  const classGrid = new Uint8Array(N); // all no-change, inside
  const labels = new Int32Array(N);
  const stats = computeStats({ classGrid, labels, grid });

  const expectedHa = (N * grid.metersX * grid.metersY) / 10_000;
  assert.ok(
    Math.abs(stats.areaHa - expectedHa) / expectedHa < 1e-9,
    `areaHa=${stats.areaHa} expected=${expectedHa}`,
  );
  assert.ok(Math.abs(stats.areaHa - 36) / 36 < 0.01, `areaHa=${stats.areaHa} ≈ 36 ha`);
  assert.equal(stats.validPct, 100);
});

test("rasterizeAreaMask fills polygons and subtracts holes", () => {
  const grid = testGrid();
  const squarePoly = (row0: number, col0: number, size: number): GeoJSON.Polygon => {
    const west = grid.bbox[0] + col0 * grid.pxLon;
    const east = grid.bbox[0] + (col0 + size) * grid.pxLon;
    const north = grid.bbox[3] - row0 * grid.pxLat;
    const south = grid.bbox[3] - (row0 + size) * grid.pxLat;
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
  };

  const solid = rasterizeAreaMask(squarePoly(10, 10, 20), grid);
  assert.equal(solid.reduce((sum, v) => sum + v, 0), 400);

  // Exterior = full grid, hole = 10×10 block → 3600 − 100 inside.
  const holed: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [grid.bbox[0], grid.bbox[1]],
        [grid.bbox[2], grid.bbox[1]],
        [grid.bbox[2], grid.bbox[3]],
        [grid.bbox[0], grid.bbox[3]],
        [grid.bbox[0], grid.bbox[1]],
      ],
      squarePoly(25, 25, 10).coordinates[0],
    ],
  };
  const withHole = rasterizeAreaMask(holed, grid);
  assert.equal(withHole.reduce((sum, v) => sum + v, 0), N - 100);
});

test("zonal stats: tehsil rows carry the change of their own side", () => {
  const grid = testGrid();
  const west = grid.bbox[0];
  const midLon = west + (W / 2) * grid.pxLon;
  const east = grid.bbox[2];
  const [south, north] = [grid.bbox[1], grid.bbox[3]];
  const rect = (x0: number, x1: number): GeoJSON.Polygon => ({
    type: "Polygon",
    coordinates: [
      [
        [x0, south],
        [x1, south],
        [x1, north],
        [x0, north],
        [x0, south],
      ],
    ],
  });
  const zones = rasterizeZones(
    [
      { id: "t1", geometry: rect(west, midLon) },
      { id: "t2", geometry: rect(midLon, east) },
    ],
    grid,
  );
  assert.equal(zones.filter((z) => z === 1).length, N / 2);
  assert.equal(zones.filter((z) => z === 2).length, N / 2);

  const inside = ones();
  const a = baseIndices();
  const b = baseIndices();
  setSquare(b.ndvi, 20, 5, 10, 0.2); // veg loss on the WEST (zone 1) only
  const valid = dilateInvalid(combineValidity(ones(), ones(), inside), W, H);
  let classGrid = classifyChange(a, b, valid, inside, scaledThresholds("medium"));
  classGrid = majorityFilter(classGrid, valid, W, H);
  const { labels } = labelPatches(classGrid, W, H, minPatchPixels(0.2, grid.metersX, grid.metersY));
  const stats = computeStats({
    classGrid,
    labels,
    grid,
    zones,
    zoneMeta: [
      { id: "t1", name: "West" },
      { id: "t2", name: "East" },
    ],
  });

  assert.ok(stats.tehsils, "zonal rows present");
  const westRow = stats.tehsils!.find((r) => r.tehsilId === "t1")!;
  const eastRow = stats.tehsils!.find((r) => r.tehsilId === "t2")!;
  assert.ok(westRow.changedHa > 0, "west tehsil holds the change");
  assert.equal(eastRow.changedHa, 0, "east tehsil unchanged");
  assert.equal(stats.hotspots[0].tehsilName, "West", "hotspot attributed to the right tehsil");
});
