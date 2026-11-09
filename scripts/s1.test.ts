import "./alias-hook";
import assert from "node:assert/strict";
import test from "node:test";
import { S1_EVALSCRIPT } from "../lib/analysis/evalscript";
import type { ParsedS1Side } from "../lib/analysis/parse";
import {
  fetchS1Pair,
  otsuVhThreshold,
  radarWaterMask,
  sarFeatures,
  s1DataEntry,
  sideHasData,
  toDb,
  WATER_VH_DB_MAX,
  WATER_VH_DB_MIN,
  type S1FetchDeps,
  type S1Orbit,
} from "../lib/analysis/s1";

/**
 * Phase 1 — Sentinel-1 GRD evidence: request option names (docs-verified),
 * dB conversion, adaptive Otsu water mask, feature stack and the
 * one-orbit-per-side pair fetch (injectable deps, offline).
 */

function makeSide(opts: {
  count: number[];
  vvDb?: number[];
  vhDb?: number[];
}): ParsedS1Side {
  const n = opts.count.length;
  const count = Float32Array.from(opts.count);
  const vvDb = new Float32Array(n);
  const vhDb = new Float32Array(n);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (count[i] >= 1) {
      valid[i] = 1;
      vvDb[i] = opts.vvDb?.[i] ?? -10;
      vhDb[i] = opts.vhDb?.[i] ?? -18;
    } else {
      vvDb[i] = NaN;
      vhDb[i] = NaN;
    }
  }
  return { width: n, height: 1, vvDb, vhDb, count, valid };
}

test("s1 evalscript: ORBIT median of VV/VH with nodata guards", () => {
  assert.ok(S1_EVALSCRIPT.includes('mosaicking: "ORBIT"'));
  assert.ok(S1_EVALSCRIPT.includes('bands: ["VV", "VH", "dataMask"]'));
  assert.ok(S1_EVALSCRIPT.includes("bands: 3"));
  assert.ok(S1_EVALSCRIPT.includes("sampleType: \"FLOAT32\""));
  assert.ok(S1_EVALSCRIPT.includes("s.dataMask !== 1"));
  assert.ok(S1_EVALSCRIPT.includes("!(s.VV > 0)"));
  assert.ok(S1_EVALSCRIPT.includes("median(vv)"));
  assert.ok(S1_EVALSCRIPT.includes("vv.length"));
});

test("s1DataEntry: docs-verified option names", () => {
  const entry = s1DataEntry("ASCENDING", {
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-13T00:00:00Z",
  });
  assert.equal(entry.type, "sentinel-1-grd");
  const f = entry.dataFilter as Record<string, unknown>;
  assert.equal(f.acquisitionMode, "IW");
  assert.equal(f.polarization, "DV"); // dual VV+VH
  assert.equal(f.resolution, "HIGH"); // 10 m/px IW
  assert.equal(f.orbitDirection, "ASCENDING");
  assert.deepEqual(f.timeRange, {
    from: "2026-09-01T00:00:00Z",
    to: "2026-09-13T00:00:00Z",
  });
  const p = entry.processing as Record<string, unknown>;
  assert.equal(p.backCoeff, "GAMMA0_TERRAIN"); // terrain-corrected gamma0
  assert.equal(p.orthorectify, "true"); // string per docs examples
  assert.equal(p.demInstance, "COPERNICUS_30"); // Copernicus DEM
  assert.deepEqual(p.speckleFilter, { type: "LEE", windowSizeX: 5, windowSizeY: 5 });
});

test("toDb: linear power to dB, nodata guard", () => {
  assert.equal(toDb(1), 0);
  assert.ok(Math.abs(toDb(0.01) - -20) < 1e-9);
  assert.ok(Math.abs(toDb(0.001) - -30) < 1e-9);
  assert.ok(Number.isNaN(toDb(0)));
  assert.ok(Number.isNaN(toDb(-5)));
});

test("sideHasData: any pixel with count >= 1", () => {
  assert.equal(sideHasData(makeSide({ count: [0, 0, 0] })), false);
  assert.equal(sideHasData(makeSide({ count: [0, 2, 0] })), true);
});

test("otsuVhThreshold: bimodal split stays inside sane bounds", () => {
  // Dark cluster (water-like) + bright cluster (land-like).
  const vh = Float32Array.from([
    -26, -25, -24, -25, -26, -24, -25, -26, // dark
    -9, -8, -10, -9, -8, -9, -10, -8, // bright
  ]);
  const valid = new Uint8Array(vh.length).fill(1);
  const t = otsuVhThreshold(vh, valid);
  assert.ok(t > -24 && t < -10, `threshold ${t} should sit between the modes`);
  assert.ok(t >= WATER_VH_DB_MIN && t <= WATER_VH_DB_MAX);
});

test("otsuVhThreshold: no valid pixels → NaN; out-of-range values clamp", () => {
  const none = new Float32Array(4);
  const zero = new Uint8Array(4);
  assert.ok(Number.isNaN(otsuVhThreshold(none, zero)));

  // All values below the floor → threshold must clamp to the floor.
  const dark = Float32Array.from([-42, -41, -40, -42, -41, -40, -42, -41]);
  const valid = new Uint8Array(dark.length).fill(1);
  assert.equal(otsuVhThreshold(dark, valid), WATER_VH_DB_MIN);
});

test("radarWaterMask: dark valid pixels flagged, invalid never flagged", () => {
  const vh = Float32Array.from([-26, -25, -9, -8, NaN]);
  const valid = Uint8Array.from([1, 1, 1, 1, 0]);
  const { mask, threshold } = radarWaterMask(vh, valid);
  assert.ok(Number.isFinite(threshold));
  assert.equal(mask[0], 1);
  assert.equal(mask[1], 1);
  assert.equal(mask[2], 0);
  assert.equal(mask[3], 0);
  assert.equal(mask[4], 0); // invalid pixel never water
  for (let i = 0; i < vh.length; i++) {
    if (valid[i] === 1 && mask[i] === 1) assert.ok(vh[i] <= threshold);
  }
});

test("sarFeatures: deltas, ratio and validity intersection", () => {
  const a = makeSide({
    count: [2, 2, 0],
    vvDb: [-10, -12, 0],
    vhDb: [-18, -20, 0],
  });
  const b = makeSide({
    count: [2, 2, 2],
    vvDb: [-7, -12, -9],
    vhDb: [-16, -20, -15],
  });
  const f = sarFeatures(a, b);
  assert.ok(Math.abs(f.dVV[0] - 3) < 1e-6); // -7 − (-10)
  assert.ok(Math.abs(f.dVH[0] - 2) < 1e-6); // -16 − (-18)
  assert.ok(Math.abs(f.dRatio[0] - 1) < 1e-6); // ΔVV − ΔVH
  assert.equal(f.valid[0], 1);
  assert.equal(f.valid[1], 1);
  assert.equal(f.valid[2], 0); // A invalid → NaN deltas
  assert.ok(Number.isNaN(f.dVV[2]));
  assert.equal(f.waterMaskA.length, 3);
  assert.equal(f.waterMaskB.length, 3);
  assert.throws(() => sarFeatures(a, makeSide({ count: [1] })), /size mismatch/);
});

/* ------------------------------------------------------------------ */
/* fetchS1Pair — orbit fallback with injected I/O                      */
/* ------------------------------------------------------------------ */

interface Call {
  date: string;
  orbit: S1Orbit;
}

function pairDeps(plan: {
  /** side key `${date}|${orbit}` → count array (missing key = fetch throws). */
  sides: Record<string, number[]>;
  calls?: Call[];
}): S1FetchDeps {
  const calls = plan.calls ?? [];
  return {
    fetchSide: async (date, _other, orbit) => {
      calls.push({ date, orbit });
      const key = `${date}|${orbit}`;
      const counts = plan.sides[key];
      if (!counts) throw new Error(`unexpected fetch ${key}`);
      return Buffer.from(key, "utf8"); // opaque; parseSide re-derives from key
    },
    parseSide: async (buffer) => {
      const key = buffer.toString("utf8");
      const [date, orbit] = key.split("|");
      const counts = plan.sides[`${date}|${orbit}`];
      assert.ok(counts, `parse without fetch for ${date}|${orbit}`);
      return makeSide({ count: counts });
    },
  };
}

const PARAMS = { dateA: "2026-09-10", dateB: "2026-10-20" };

test("fetchS1Pair: ASC data on both sides → one direction, two fetches", async () => {
  const calls: Call[] = [];
  const deps = pairDeps({
    sides: {
      "2026-09-10|ASCENDING": [2, 2],
      "2026-10-20|ASCENDING": [3, 3],
    },
    calls,
  });
  const out = await fetchS1Pair(PARAMS, deps);
  assert.ok(out.ok);
  if (out.ok) {
    assert.equal(out.orbit, "ASCENDING");
    assert.equal(sideHasData(out.a), true);
    assert.equal(sideHasData(out.b), true);
  }
  assert.equal(calls.length, 2);
});

test("fetchS1Pair: empty ASC on A falls back to DESC for both sides", async () => {
  const calls: Call[] = [];
  const deps = pairDeps({
    sides: {
      "2026-09-10|ASCENDING": [0, 0],
      "2026-09-10|DESCENDING": [2],
      "2026-10-20|DESCENDING": [4],
    },
    calls,
  });
  const out = await fetchS1Pair(PARAMS, deps);
  assert.ok(out.ok);
  if (out.ok) assert.equal(out.orbit, "DESCENDING");
  // A-ASC probed (no data → B skipped), then DESC pair.
  assert.deepEqual(
    calls.map((c) => `${c.date}|${c.orbit}`),
    ["2026-09-10|ASCENDING", "2026-09-10|DESCENDING", "2026-10-20|DESCENDING"],
  );
});

test("fetchS1Pair: B empty on ASC retries the full pair on DESC", async () => {
  const calls: Call[] = [];
  const deps = pairDeps({
    sides: {
      "2026-09-10|ASCENDING": [2],
      "2026-10-20|ASCENDING": [0],
      "2026-09-10|DESCENDING": [2],
      "2026-10-20|DESCENDING": [2],
    },
    calls,
  });
  const out = await fetchS1Pair(PARAMS, deps);
  assert.ok(out.ok);
  if (out.ok) assert.equal(out.orbit, "DESCENDING");
  assert.equal(calls.length, 4); // A,B on ASC + A,B on DESC
});

test("fetchS1Pair: no data in either direction → no-common-orbit", async () => {
  const deps = pairDeps({
    sides: {
      "2026-09-10|ASCENDING": [0],
      "2026-09-10|DESCENDING": [0],
    },
  });
  const out = await fetchS1Pair(PARAMS, deps);
  assert.equal(out.ok, false);
  if (!out.ok) assert.equal(out.reason, "no-common-orbit");
});

test("fetchS1Pair: budget error stops probing immediately", async () => {
  let fetches = 0;
  const deps: S1FetchDeps = {
    fetchSide: async () => {
      fetches += 1;
      const err = new Error("budget") as Error & { code?: string };
      err.code = "DAILY_BUDGET_EXCEEDED";
      throw err;
    },
    parseSide: async () => makeSide({ count: [1] }),
  };
  const out = await fetchS1Pair(PARAMS, deps);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "fetch-failed");
    assert.equal(out.detail, "DAILY_BUDGET_EXCEEDED");
  }
  assert.equal(fetches, 1);
});

test("fetchS1Pair: generic fetch error → fetch-failed", async () => {
  const deps: S1FetchDeps = {
    fetchSide: async () => {
      throw new Error("boom");
    },
    parseSide: async () => makeSide({ count: [1] }),
  };
  const out = await fetchS1Pair(PARAMS, deps);
  assert.equal(out.ok, false);
  if (!out.ok) {
    assert.equal(out.reason, "fetch-failed");
    assert.match(out.detail ?? "", /boom/);
  }
});
