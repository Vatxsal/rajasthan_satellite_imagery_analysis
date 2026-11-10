import "./alias-hook";
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearWorldCoverCache,
  fetchWorldCoverPrior,
  priorIsBuiltup,
  priorIsCropland,
  priorIsWater,
  WC,
  worldCoverTileId,
  worldCoverTileUrl,
  worldCoverTilesForBbox,
  type PriorGrid,
  type WorldCoverDeps,
} from "../lib/analysis/prior";
import {
  computeTerrain,
  demDataEntry,
  DEM_EVALSCRIPT,
  TERRAIN_SHADOW_HS,
} from "../lib/analysis/terrain";

/**
 * Phase 2 — context (ESA WorldCover prior: official tile URLs, merge,
 * cache, graceful failure) and terrain (slope/hillshade/shadow on known
 * surfaces). All network I/O injected; no external calls.
 */

function gridFixture(overrides: Partial<PriorGrid> = {}): PriorGrid {
  return {
    bbox: [74.0, 26.0, 74.5, 26.5],
    width: 10,
    height: 10,
    pxLon: 0.05,
    pxLat: 0.05,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* WorldCover tiles / URLs                                             */
/* ------------------------------------------------------------------ */

test("worldCoverTileId: PUM §3.1 naming (S48E036 example)", () => {
  assert.equal(worldCoverTileId(-48, 36), "S48E036");
  assert.equal(worldCoverTileId(24, 69), "N24E069");
  assert.equal(worldCoverTileId(0, 0), "N00E000");
  assert.equal(worldCoverTileId(-4, -7), "S04W007");
});

test("worldCoverTilesForBbox: single tile, edge multiples, multi-tile", () => {
  // Fully inside N24E072 (24..27N, 72..75E).
  assert.deepEqual(worldCoverTilesForBbox([74.0, 26.0, 74.5, 26.5]), [
    "N24E072",
  ]);
  // Crosses 75E → second column; crosses 27N → second row.
  assert.deepEqual(worldCoverTilesForBbox([74.8, 26.9, 75.2, 27.1]), [
    "N24E072",
    "N24E075",
    "N27E072",
    "N27E075",
  ]);
  // Exact far edge (north = 27.0) stays in the lower tile.
  assert.deepEqual(worldCoverTilesForBbox([74.0, 26.0, 74.5, 27.0]), [
    "N24E072",
  ]);
});

test("worldCoverTileUrl: official PUM §5.3 AWS pattern", () => {
  assert.equal(
    worldCoverTileUrl("N24E072"),
    "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N24E072_Map.tif",
  );
});

/* ------------------------------------------------------------------ */
/* Prior fetch: merge, cache, graceful failure                          */
/* ------------------------------------------------------------------ */

test("fetchWorldCoverPrior: merges tile reads into the grid", async () => {
  clearWorldCoverCache();
  const grid = gridFixture();
  const calls: string[] = [];
  const deps: WorldCoverDeps = {
    readTile: async (url) => {
      calls.push(url);
      // First tile covers the whole grid.
      return {
        col0: 0,
        row0: 0,
        cols: grid.width,
        rows: grid.height,
        values: new Uint8Array(grid.width * grid.height).fill(WC.builtup),
      };
    },
  };
  const prior = await fetchWorldCoverPrior(grid, deps);
  assert.ok(prior);
  assert.equal(prior.tiles.length, 1);
  assert.equal(prior.year, 2021);
  assert.equal(prior.valid[0], 1);
  assert.equal(prior.cls[grid.width * grid.height - 1], WC.builtup);
  assert.ok(priorIsBuiltup(prior, 0));
  assert.ok(!priorIsCropland(prior, 0));
  assert.ok(!priorIsWater(prior, 0));
  assert.equal(calls.length, 1);

  // Cached — second call must not re-read.
  const again = await fetchWorldCoverPrior(grid, deps);
  assert.equal(again, prior);
  assert.equal(calls.length, 1);
});

test("fetchWorldCoverPrior: partial coverage keeps valid=0 elsewhere", async () => {
  clearWorldCoverCache();
  const grid = gridFixture();
  const deps: WorldCoverDeps = {
    readTile: async () => ({
      col0: 0,
      row0: 0,
      cols: 4,
      rows: 4,
      values: new Uint8Array(16).fill(WC.cropland),
    }),
  };
  const prior = await fetchWorldCoverPrior(grid, deps);
  assert.ok(prior);
  assert.equal(prior.valid[0], 1);
  assert.equal(prior.valid[4 * grid.width + 4], 0);
  assert.equal(prior.cls[4 * grid.width + 4], WC.nodata);
  assert.ok(priorIsCropland(prior, 0));
});

test("fetchWorldCoverPrior: all tiles failing → null (feature off)", async () => {
  clearWorldCoverCache();
  const nullDeps: WorldCoverDeps = { readTile: async () => null };
  assert.equal(await fetchWorldCoverPrior(gridFixture(), nullDeps), null);

  clearWorldCoverCache();
  const throwDeps: WorldCoverDeps = {
    readTile: async () => {
      throw new Error("network down");
    },
  };
  assert.equal(await fetchWorldCoverPrior(gridFixture(), throwDeps), null);
});

/* ------------------------------------------------------------------ */
/* Terrain                                                             */
/* ------------------------------------------------------------------ */

test("demDataEntry + evalscript: docs-verified option names", () => {
  const entry = demDataEntry("COPERNICUS_30");
  assert.equal(entry.type, "dem");
  assert.equal(entry.dataFilter.demInstance, "COPERNICUS_30");
  assert.equal(entry.processing.upsampling, "BICUBIC");
  assert.ok(DEM_EVALSCRIPT.includes('input: ["DEM"]'));
  assert.ok(DEM_EVALSCRIPT.includes('sampleType: "FLOAT32"'));
  assert.ok(DEM_EVALSCRIPT.includes("return [sample.DEM]"));
});

/** Elevation plane: z = z0 + east-grad·(col·metersX) − south-grad·(row·metersY). */
function planeElevation(
  width: number,
  height: number,
  dzdEast: number,
  dzdSouth: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      out[r * width + c] = 100 + dzdEast * c * 10 - dzdSouth * r * 10;
    }
  }
  return out;
}

const TERRAIN_GRID = { width: 9, height: 9, metersX: 10, metersY: 10 };

test("computeTerrain: flat surface → slope 0, hillshade sin(45°), no shadow", () => {
  const flat = planeElevation(9, 9, 0, 0);
  const t = computeTerrain(flat, TERRAIN_GRID);
  for (let i = 0; i < t.slopeDeg.length; i++) {
    assert.ok(Math.abs(t.slopeDeg[i]) < 1e-4, `slope ${t.slopeDeg[i]}`);
    assert.ok(
      Math.abs(t.hillshade[i] - Math.SQRT1_2) < 1e-3,
      `hillshade ${t.hillshade[i]}`,
    );
    assert.equal(t.shadow[i], 0);
  }
});

test("computeTerrain: known gradient → slope = atan(gradient)", () => {
  // dz/dEast = 0.2 → slope = atan(0.2) ≈ 11.31°.
  const plane = planeElevation(9, 9, 0.2, 0);
  const t = computeTerrain(plane, TERRAIN_GRID);
  // Interior pixels are exact on a linear surface (Horn = central diff).
  const i = 4 * 9 + 4;
  assert.ok(
    Math.abs(t.slopeDeg[i] - (Math.atan(0.2) * 180) / Math.PI) < 1e-3,
    `slope ${t.slopeDeg[i]}`,
  );
});

test("computeTerrain: steep slope away from the sun → terrain shadow", () => {
  // Descending southward at ~75° — away from the 315°/45° sun → hs ≈ 0.
  const steep = planeElevation(9, 9, 0, Math.tan((75 * Math.PI) / 180));
  const t = computeTerrain(steep, TERRAIN_GRID);
  const i = 4 * 9 + 4;
  assert.ok(t.slopeDeg[i] > 70, `slope ${t.slopeDeg[i]}`);
  assert.ok(t.hillshade[i] < TERRAIN_SHADOW_HS, `hs ${t.hillshade[i]}`);
  assert.equal(t.shadow[i], 1);
  // The same magnitude facing the sun stays lit.
  const lit = planeElevation(9, 9, 0, -Math.tan((75 * Math.PI) / 180));
  const lt = computeTerrain(lit, TERRAIN_GRID);
  assert.equal(lt.shadow[i], 0);
});

test("computeTerrain: size mismatch throws", () => {
  assert.throws(
    () => computeTerrain(new Float32Array(3), TERRAIN_GRID),
    /size mismatch/,
  );
});
