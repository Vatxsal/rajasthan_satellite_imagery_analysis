/**
 * Scenario validation (Phase 4) — drives the REAL production pipeline
 * (lib/analysis/process.ts: classify → denoise → MMU → stats) with synthetic
 * A/B rasters whose ground truth is known by construction, then vectorizes
 * every kept patch into a prediction GeoJSON for the same metrics harness
 * used against QGIS references (validation/engine.ts).
 *
 * Synthesis: each pixel takes a surface-state profile (vegetation, bare soil,
 * open water, built-up) on each side; a change shape says which state the
 * pixel changes to. Bands get deterministic Gaussian noise so the adaptive
 * thresholds see a realistic noise floor. v1 inputs are the exact v1
 * evalscript indices (deriveIndices), v2 inputs are 12-band composites
 * (median = the side's profile, recent orbit = a noisier second sample).
 *
 * Scenario sets (per engine):
 *   scenario-classes  — all five change classes on a stable background
 *   scenario-speckle  — one real block + isolated 1-px false changes (denoise)
 *   scenario-clouds   — A-side cloud blob on stable ground (no edge bleed)
 */
import { deriveIndices, type CompositeBands } from "../lib/analysis/composite";
import { makeAnalysisGrid } from "../lib/analysis/grid";
import { patchToMultiPolygon } from "../lib/analysis/polygon";
import {
  processCompare,
  type CompareSide,
  type RasterInputs,
  type RunCompareInput,
} from "../lib/analysis/process";
import type { ParsedCompositeRaster } from "../lib/analysis/parse";
import type { CompareEngine } from "../lib/analysis/types";
import type { GeoJsonFeature, GeoJsonFeatureCollection, RefClass, ValidationCase } from "./engine";

/* ------------------------------------------------------------------ */
/* geometry + surface profiles                                         */
/* ------------------------------------------------------------------ */

type Rect = [number, number, number, number]; // west, south, east, north
type State = "veg" | "bare" | "water" | "built";

/** Scenario extent: a 0.04° box near Ajmer (~11 m pixels at maxPx 400). */
const BBOX: Rect = [74.0, 26.0, 74.04, 26.04];
const WIDTH_PX = 400; // long side (lat) — width follows cos-lat via computeOutputSize

/** Sentinel-2-like reflectance per surface state (B02 B03 B04 B05 B08 B11 B12). */
const PROFILES: Record<State, [number, number, number, number, number, number, number]> = {
  veg: [0.05, 0.06, 0.045, 0.3, 0.42, 0.22, 0.19],
  bare: [0.15, 0.17, 0.14, 0.26, 0.2, 0.24, 0.22],
  water: [0.04, 0.055, 0.025, 0.04, 0.015, 0.03, 0.025],
  // B02 raised / B04 trimmed vs. the original profile: bare→built must not
  // vote the corroboration indices of veg_loss (dBsi) at the 0.7 scale floor,
  // and the Δ-ndbi/Δ-brightness pair alone still wins bareBuilt 2-of-3.
  built: [0.34, 0.16, 0.1305, 0.28, 0.16, 0.42, 0.4],
};

/** CLASS code → reference vocabulary string (order matches CLASS codes 0-5). */
const CLASS_TO_REF: RefClass[] = [
  "no_change",
  "veg_gain",
  "veg_loss",
  "builtup_gain",
  "water_gain",
  "water_loss",
];

/* ------------------------------------------------------------------ */
/* deterministic noise                                                 */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Approximate standard normal in [-1.5σ, 1.5σ] — cheap, bounded, repeatable. */
function gauss(rand: () => number, sigma: number): number {
  return (rand() + rand() + rand() - 1.5) * sigma;
}

/* ------------------------------------------------------------------ */
/* scenario definitions                                                */
/* ------------------------------------------------------------------ */

interface Shape {
  cls: RefClass;
  rect: Rect;
  a: State;
  b: State;
}

interface ScenarioSpec {
  name: string;
  shapes: Shape[];
  /** Cloud rectangle: A-side invalid (valid=0, obsCount=0). */
  cloud?: Rect;
  /** Isolated false-change pixels (A=veg, B=bare) NOT in the reference. */
  speckleCount?: number;
}

const CLASS_SHAPES: Shape[] = [
  { cls: "veg_loss", rect: [74.006, 26.028, 74.014, 26.036], a: "veg", b: "bare" },
  { cls: "water_gain", rect: [74.018, 26.028, 74.025, 26.034], a: "bare", b: "water" },
  { cls: "builtup_gain", rect: [74.028, 26.027, 74.036, 26.033], a: "bare", b: "built" },
  { cls: "water_loss", rect: [74.006, 26.007, 74.013, 26.013], a: "water", b: "bare" },
  { cls: "veg_gain", rect: [74.018, 26.007, 74.026, 26.014], a: "bare", b: "veg" },
];

const SPECKLE_BLOCK: Shape = {
  cls: "veg_loss",
  rect: [74.014, 26.016, 74.026, 26.024],
  a: "veg",
  b: "bare",
};

const SPECKLE_SPECKLE_CLOUD: Rect = [74.017, 26.019, 74.023, 26.025];

const SPECS: ScenarioSpec[] = [
  { name: "scenario-classes", shapes: CLASS_SHAPES },
  {
    name: "scenario-speckle",
    shapes: [SPECKLE_BLOCK],
    speckleCount: 300,
  },
  { name: "scenario-clouds", shapes: CLASS_SHAPES, cloud: SPECKLE_SPECKLE_CLOUD },
];

/* ------------------------------------------------------------------ */
/* truth grids + synthesis                                             */
/* ------------------------------------------------------------------ */

function inRect(west: number, south: number, rect: Rect): boolean {
  return west >= rect[0] && west <= rect[2] && south >= rect[1] && south <= rect[3];
}

function pixelLonLat(col: number, row: number, width: number, height: number): [number, number] {
  const pxLon = (BBOX[2] - BBOX[0]) / width;
  const pxLat = (BBOX[3] - BBOX[1]) / height;
  return [BBOX[0] + (col + 0.5) * pxLon, BBOX[3] - (row + 0.5) * pxLat];
}

interface SynthGrid {
  width: number;
  height: number;
  /** Surface state per pixel per side (state → index 0-3). */
  aState: Uint8Array;
  bState: Uint8Array;
  /** 1 where A-side is cloud/nodata. */
  aInvalid: Uint8Array;
  /** 1 where the pixel is part of an injected speckle false change. */
  speckle: Uint8Array;
}

const STATE_INDEX: Record<State, number> = { veg: 0, bare: 1, water: 2, built: 3 };

function buildTruth(spec: ScenarioSpec): SynthGrid {
  // computeOutputSize on the exact extent: long side = lat = 400 px.
  const height = WIDTH_PX;
  const midLatRad = ((BBOX[1] + BBOX[3]) / 2) * (Math.PI / 180);
  const widthDeg = (BBOX[2] - BBOX[0]) * Math.cos(midLatRad);
  const width = Math.max(1, Math.round((WIDTH_PX * widthDeg) / (BBOX[3] - BBOX[1])));
  const n = width * height;
  const aState = new Uint8Array(n).fill(STATE_INDEX.veg);
  const bState = new Uint8Array(n).fill(STATE_INDEX.veg);
  const aInvalid = new Uint8Array(n);
  const speckle = new Uint8Array(n);

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      const [lon, lat] = pixelLonLat(col, row, width, height);
      for (const shape of spec.shapes) {
        if (inRect(lon, lat, shape.rect)) {
          aState[i] = STATE_INDEX[shape.a];
          bState[i] = STATE_INDEX[shape.b];
        }
      }
      if (spec.cloud && inRect(lon, lat, spec.cloud)) aInvalid[i] = 1;
    }
  }

  if (spec.speckleCount) {
    // Isolated single pixels on a 4-px lattice (never adjacent), outside the
    // real block: the engine must erase them via the majority filter.
    const rand = mulberry32(20261030);
    let placed = 0;
    let attempts = 0;
    while (placed < spec.speckleCount && attempts < spec.speckleCount * 40) {
      attempts++;
      const col = 3 + Math.floor(rand() * (width - 6));
      const row = 3 + Math.floor(rand() * (height - 6));
      if (col % 4 !== 0 || row % 4 !== 0) continue;
      const i = row * width + col;
      if (speckle[i] === 1) continue;
      let inBlock = false;
      for (const shape of spec.shapes) {
        const [lon, lat] = pixelLonLat(col, row, width, height);
        if (inRect(lon, lat, shape.rect)) inBlock = true;
      }
      if (inBlock) continue;
      aState[i] = STATE_INDEX.veg;
      bState[i] = STATE_INDEX.bare;
      speckle[i] = 1;
      placed++;
    }
  }
  return { width, height, aState, bState, aInvalid, speckle };
}

/** Noisy band cube for one side: 7 Float32Arrays of length w×h. */
function buildBands(grid: SynthGrid, side: "a" | "b", seed: number): CompositeBands {
  const n = grid.width * grid.height;
  const out: CompositeBands = {
    b02: new Float32Array(n),
    b03: new Float32Array(n),
    b04: new Float32Array(n),
    b05: new Float32Array(n),
    b08: new Float32Array(n),
    b11: new Float32Array(n),
    b12: new Float32Array(n),
  };
  const rand = mulberry32(seed);
  const stateGrid = side === "a" ? grid.aState : grid.bState;
  const keys: Array<keyof CompositeBands> = ["b02", "b03", "b04", "b05", "b08", "b11", "b12"];
  const states: State[] = ["veg", "bare", "water", "built"];
  for (let i = 0; i < n; i++) {
    const profile = PROFILES[states[stateGrid[i]]];
    for (let b = 0; b < 7; b++) {
      out[keys[b]][i] = profile[b] + gauss(rand, 0.003);
    }
  }
  return out;
}

/** Composite-style side: median bands = profile+noise, recent = second sample. */
function buildCompositeSide(
  grid: SynthGrid,
  side: "a" | "b",
  medianSeed: number,
  recentSeed: number,
): ParsedCompositeRaster {
  const n = grid.width * grid.height;
  const bands = buildBands(grid, side, medianSeed);
  const recentBands = buildBands(grid, side, recentSeed);
  const recent = deriveIndices(recentBands);
  const valid = new Uint8Array(n);
  const obsCount = new Float32Array(n);
  const scl = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const invalid = side === "a" && grid.aInvalid[i] === 1;
    valid[i] = invalid ? 0 : 1;
    obsCount[i] = invalid ? 0 : 6;
    scl[i] = 4;
  }
  return {
    width: grid.width,
    height: grid.height,
    ...bands,
    valid,
    obsCount,
    scl,
    recentNdvi: recent.ndvi,
    recentMndwi: recent.mndwi,
    recentNdbi: recent.ndbi,
  };
}

/** v1 side: exact evalscript indices from the side's noisy bands. */
function buildSingleSide(grid: SynthGrid, side: "a" | "b", seed: number): CompareSide {
  const n = grid.width * grid.height;
  const bands = buildBands(grid, side, seed);
  const indices = deriveIndices(bands);
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    valid[i] = side === "a" && grid.aInvalid[i] === 1 ? 0 : 1;
  }
  return { indices, valid, width: grid.width, height: grid.height };
}

/* ------------------------------------------------------------------ */
/* reference + prediction GeoJSON                                      */
/* ------------------------------------------------------------------ */

function rectRing(rect: Rect): number[][] {
  const [w, s, e, n] = rect;
  return [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s],
  ];
}

function referenceCollection(spec: ScenarioSpec): GeoJsonFeatureCollection {
  const features: GeoJsonFeature[] = [
    { type: "Feature", properties: { cls: "no_change" }, geometry: { type: "Polygon", coordinates: [rectRing(BBOX)] } },
  ];
  for (const shape of spec.shapes) {
    features.push({
      type: "Feature",
      properties: { cls: shape.cls },
      geometry: { type: "Polygon", coordinates: [rectRing(shape.rect)] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Vectors EVERY kept patch (not just the top-10 hotspots) for the harness. */
function predictionCollection(
  classGrid: Uint8Array,
  labels: Int32Array,
  width: number,
  height: number,
  bbox: [number, number, number, number],
): GeoJsonFeatureCollection {
  const grid = makeAnalysisGrid(bbox, width, height);
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (label === 0) continue;
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = [];
      buckets.set(label, bucket);
    }
    bucket.push(i);
  }
  const features: GeoJsonFeature[] = [];
  buckets.forEach((pixels) => {
    const code = classGrid[pixels[0]];
    const polygon = patchToMultiPolygon(pixels, width, grid);
    if (!polygon) return;
    features.push({
      type: "Feature",
      properties: { cls: CLASS_TO_REF[code] ?? "no_change", classCode: code },
      geometry: polygon,
    });
  });
  return { type: "FeatureCollection", features };
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

const DATE_A = "2026-05-01";
const DATE_B = "2026-05-20"; // gap 19 d, outside Rajasthan seasonal windows

function runScenario(engine: CompareEngine, spec: ScenarioSpec): ValidationCase {
  const truth = buildTruth(spec);
  const input: RunCompareInput = {
    geometry: {
      type: "Polygon",
      coordinates: [rectRing(BBOX)],
    },
    dateA: DATE_A,
    dateB: DATE_B,
    areaName: `Scenario ${spec.name}`,
    areaLevel: "tehsil",
    areaId: `scenario-${spec.name.toLowerCase().replace(/\s+/g, "-")}`,
    sensitivity: "medium",
    maxPx: WIDTH_PX,
    engine,
    inputMode: engine === "v2" ? "composite" : undefined,
    compositeWindowDays: engine === "v2" ? 7 : undefined,
  };
  const inputs: RasterInputs =
    engine === "v2"
      ? {
          parsedA: buildCompositeSide(truth, "a", 1001, 1002),
          parsedB: buildCompositeSide(truth, "b", 2001, 2002),
        }
      : {
          sideA: buildSingleSide(truth, "a", 1001),
          sideB: buildSingleSide(truth, "b", 2001),
        };
  const artifact = processCompare(input, inputs);
  const prediction = predictionCollection(
    artifact.classGrid,
    artifact.labels,
    artifact.width,
    artifact.height,
    artifact.bbox,
  );
  return {
    name: `${spec.name}-${engine}`,
    reference: referenceCollection(spec),
    prediction,
    meta: { dateA: DATE_A, dateB: DATE_B, engine },
  };
}

/** The scenario set for one engine (optionally a single scenario by name). */
export function buildScenarios(engine: CompareEngine, only?: string): ValidationCase[] {
  return SPECS.filter((s) => !only || s.name === only || `${s.name}-${engine}` === only).map(
    (spec) => runScenario(engine, spec),
  );
}
