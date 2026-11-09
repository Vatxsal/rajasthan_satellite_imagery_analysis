/**
 * Phase 4 — optional ML classifier (CHANGE_RULES=ml; off by default).
 *
 * Softmax (multinomial logistic) regression over per-pixel features. The
 * model is a plain JSON file trained offline by `ml/train.py` from the
 * `npm run features` export — inference needs no ML dependency (~20
 * multiplies per pixel). Without a trained model the mode fails loudly
 * (CDSE_ML_MODEL_MISSING) instead of silently degrading to another ruleset.
 *
 * Feature parity: extraction mirrors `classifyFused` (same index deltas,
 * same CVA normalisation against the adaptive thresholds) so training rows
 * and inference see identical numbers. Sub-labels are NOT modelled (scaffold
 * emits class + confidence only); persistence reuses the v2 recent-orbit
 * rule.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLASS, VOTE } from "./config";
import { tierFromConf, type ClassifyFusedInput } from "./fused";
import { PERSIST, type ClassifyV2Output } from "./v2/classify";

/** Canonical feature order — train.py writes these names into the model. */
export const ML_FEATURES = [
  "dNdvi",
  "dMndwi",
  "dNdbi",
  "dNdmi",
  "dNdwi",
  "dBsi",
  "dAwei",
  "dBright",
  "dNbr",
  "recentNdvi",
  "recentMndwi",
  "recentNdbi",
  "cva",
  "sarWaterTrans",
  "sarDvh",
  "priorCode",
  "shadow",
  "seasonalLoss",
  "seasonalGain",
  "shortGap",
] as const;

export type MlFeatureName = (typeof ML_FEATURES)[number];

const CVA_IDX = ML_FEATURES.indexOf("cva");

/** Trained model JSON (ml/train.py output). `weights[c][k]` for classes[c]. */
export interface MlModel {
  version: number;
  /** Feature names in ML_FEATURES order (a subset is allowed). */
  features: string[];
  /** CLASS codes the model can emit (includes noChange). */
  classes: number[];
  /** Standardisation of the raw features: z = (x - mean) / std. */
  mean: number[];
  std: number[];
  weights: number[][];
  bias: number[];
}

export const DEFAULT_ML_MODEL_PATH = "artifacts/ml/model.json";

/** Model path: ML_MODEL_PATH env override, else the default artifacts path. */
export function mlModelPath(): string {
  return process.env.ML_MODEL_PATH?.trim() || DEFAULT_ML_MODEL_PATH;
}

function badModel(message: string): never {
  throw Object.assign(new Error(`ml model: ${message}`), {
    status: 500,
    code: "CDSE_ML_MODEL_BAD",
  });
}

function validateMlModel(value: unknown): MlModel {
  if (typeof value !== "object" || value === null) badModel("not an object");
  const m = value as Partial<MlModel>;
  if (m.version !== 1) badModel(`unsupported version ${String(m.version)}`);
  if (!Array.isArray(m.features) || m.features.length === 0) badModel("features missing");
  if (!Array.isArray(m.classes) || m.classes.length === 0) badModel("classes missing");
  if (!Array.isArray(m.mean) || m.mean.length !== m.features.length) badModel("mean length");
  if (!Array.isArray(m.std) || m.std.length !== m.features.length) badModel("std length");
  if (!Array.isArray(m.weights) || m.weights.length !== m.classes.length) {
    badModel("weights rows");
  }
  if (!Array.isArray(m.bias) || m.bias.length !== m.classes.length) badModel("bias length");
  for (const name of m.features) {
    if (!(ML_FEATURES as readonly string[]).includes(name)) badModel(`unknown feature ${name}`);
  }
  if (new Set(m.features).size !== m.features.length) badModel("duplicate features");
  for (const code of m.classes) {
    if (!Number.isInteger(code) || code < 0 || code > 5) badModel(`class code ${code}`);
  }
  for (let c = 0; c < m.classes.length; c++) {
    const row = m.weights[c];
    if (!Array.isArray(row) || row.length !== m.features.length) badModel("weights cols");
    for (const v of row) if (typeof v !== "number" || !Number.isFinite(v)) badModel("weight value");
    if (typeof m.bias[c] !== "number" || !Number.isFinite(m.bias[c])) badModel("bias value");
  }
  for (const v of [...m.mean, ...m.std]) {
    if (typeof v !== "number" || !Number.isFinite(v)) badModel("mean/std value");
  }
  return m as MlModel;
}

/**
 * Loads the model JSON from `modelPath` (default: ML_MODEL_PATH or
 * artifacts/ml/model.json). Missing file → CDSE_ML_MODEL_MISSING (the user
 * must train one first); malformed content → CDSE_ML_MODEL_BAD.
 */
export function loadMlModel(modelPath: string = mlModelPath()): MlModel {
  const resolved = path.resolve(process.cwd(), modelPath);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    throw Object.assign(
      new Error(
        `No ML model at ${modelPath} — train one first: npm run features && python ml/train.py`,
      ),
      { status: 422, code: "CDSE_ML_MODEL_MISSING" },
    );
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    badModel(`invalid JSON (${(err as Error).message})`);
  }
  return validateMlModel(parsed);
}

const VOTE_CORROB = VOTE.corrobFactor;

/**
 * Per-pixel feature extractor over the fused input (evidence optional).
 * Mirrors classifyFused's deltas + CVA; returns the shared `out` buffer
 * (length ML_FEATURES.length) to avoid per-pixel allocations.
 */
export function makeFeatureExtractor(
  input: ClassifyFusedInput,
): (i: number, out?: Float32Array) => Float32Array {
  const { a, b, bRecent, valid, inside, t } = input;
  const ev = input.evidence ?? {};
  const sar = ev.sar ?? null;
  const prior = ev.prior ?? null;
  const shadow = ev.shadow ?? null;

  const f = VOTE_CORROB;
  const mNdbi = Math.max(t.bareBuiltD, 1e-6);
  const mNdvi = Math.max(Math.abs(t.vegLossD), 1e-6);
  const mMndwi = Math.max(t.waterGainD, 1e-6);
  const mBsi = Math.max(f * t.bareBuiltD, 1e-6);
  const mNbr = Math.max(Math.abs(t.vegLossD), 1e-6);
  const norm = (d: number, m: number): number => Math.max(-10, Math.min(10, d / m));
  const seasonalLoss = input.seasonalLossTag ? 1 : 0;
  const seasonalGain = input.seasonalGainTag ? 1 : 0;
  const shortGap = input.shortGap ? 1 : 0;

  return (i: number, out?: Float32Array): Float32Array => {
    const o = out ?? new Float32Array(ML_FEATURES.length);
    if (inside[i] !== 1 || valid[i] !== 1) {
      o.fill(0);
      return o;
    }
    const dNdvi = b.ndvi[i] - a.ndvi[i];
    const dMndwi = b.mndwi[i] - a.mndwi[i];
    const dNdbi = b.ndbi[i] - a.ndbi[i];
    const dNdmi = b.ndmi[i] - a.ndmi[i];
    const dNdwi = b.ndwi[i] - a.ndwi[i];
    const dBsi = b.bsi[i] - a.bsi[i];
    const dAwei = b.awei[i] - a.awei[i];
    const dBright = b.brightness[i] - a.brightness[i];
    const dNbr = b.nbr[i] - a.nbr[i];

    const cva = Math.sqrt(
      norm(dNdvi, mNdvi) ** 2 +
        norm(dMndwi, mMndwi) ** 2 +
        norm(dNdbi, mNdbi) ** 2 +
        norm(dBsi, mBsi) ** 2 +
        norm(dNbr, mNbr) ** 2,
    );

    o[0] = dNdvi;
    o[1] = dMndwi;
    o[2] = dNdbi;
    o[3] = dNdmi;
    o[4] = dNdwi;
    o[5] = dBsi;
    o[6] = dAwei;
    o[7] = dBright;
    o[8] = dNbr;
    o[9] = bRecent.ndvi[i] - a.ndvi[i];
    o[10] = bRecent.mndwi[i] - a.mndwi[i];
    o[11] = bRecent.ndbi[i] - a.ndbi[i];
    o[12] = cva;
    o[13] = sar && sar.valid[i] === 1
      ? (sar.waterMaskB[i] === 1 ? 1 : 0) - (sar.waterMaskA[i] === 1 ? 1 : 0)
      : 0;
    o[14] = sar && sar.valid[i] === 1 ? sar.dVH[i] : 0;
    o[15] = prior && prior.valid[i] === 1 ? prior.cls[i] : 0;
    o[16] = shadow ? shadow[i] : 0;
    o[17] = seasonalLoss;
    o[18] = seasonalGain;
    o[19] = shortGap;
    return o;
  };
}

export interface ClassifyModelOutput extends ClassifyV2Output {
  /** 0-100 = best-class probability; 0 elsewhere (uint8 grid). */
  confGrid: Uint8Array;
}

/** A-side median driver index for the class (mirrors fused.ts). */
function driverVal(a: ClassifyFusedInput["a"], code: number, i: number): number {
  if (code === CLASS.waterGain || code === CLASS.waterLoss) return a.mndwi[i];
  if (code === CLASS.bareBuilt) return a.ndbi[i];
  return a.ndvi[i];
}

/** A-side recent-orbit driver index for the class (mirrors fused.ts). */
function aRecentVal(
  code: number,
  aRecent: ClassifyFusedInput["aRecent"],
  i: number,
): number {
  if (code === CLASS.waterGain || code === CLASS.waterLoss) return aRecent.mndwi[i];
  if (code === CLASS.bareBuilt) return aRecent.ndbi[i];
  return aRecent.ndvi[i];
}

/**
 * Runs the model over every pixel: argmax class + probability → confidence
 * (tier via the fused 75/55 cuts), persistence via the v2 recent-orbit rule,
 * sub-labels left at 0 (not modelled by the scaffold).
 */
export function classifyModel(input: ClassifyFusedInput, model: MlModel): ClassifyModelOutput {
  const { a, b, aRecent, bRecent, valid, inside, t } = input;
  const n = valid.length;
  const cols = model.features.map((name) => (ML_FEATURES as readonly string[]).indexOf(name));
  if (cols.includes(-1)) badModel("feature order");

  const classGrid = new Uint8Array(n);
  const subGrid = new Uint8Array(n);
  const tierGrid = new Uint8Array(n);
  const persistGrid = new Uint8Array(n);
  const confGrid = new Uint8Array(n);
  const extract = makeFeatureExtractor(input);
  const buf = new Float32Array(ML_FEATURES.length);

  const classes = model.classes;
  const nClasses = classes.length;
  const nFeat = model.features.length;
  const mean = model.mean;
  const std = model.std.map((s) => (s === 0 ? 1 : s));
  const W = model.weights;
  const bias = model.bias;
  // z-scores of this pixel's model features (reused buffer).
  const z = new Float32Array(nFeat);

  let changePixels = 0;
  let persistentPixels = 0;
  let transientPixels = 0;
  let cvaSum = 0;

  for (let i = 0; i < n; i++) {
    if (inside[i] !== 1) {
      classGrid[i] = CLASS.outside;
      continue;
    }
    if (valid[i] !== 1) {
      classGrid[i] = CLASS.masked;
      continue;
    }
    extract(i, buf);
    for (let k = 0; k < nFeat; k++) {
      z[k] = (buf[cols[k]] - mean[k]) / std[k];
    }
    // Softmax over the model's classes (max-subtracted for stability).
    let bestLogit = -Infinity;
    let bestIdx = 0;
    let sum = 0;
    for (let c = 0; c < nClasses; c++) {
      let logit = bias[c];
      const row = W[c];
      for (let k = 0; k < nFeat; k++) logit += row[k] * z[k];
      if (logit > bestLogit) {
        bestLogit = logit;
        bestIdx = c;
      }
      sum += Math.exp(logit);
    }
    const prob = Math.exp(bestLogit) / sum;
    const code = classes[bestIdx];
    if (code === CLASS.noChange) continue;

    // Persistence: mirrors classifyFused's recent-orbit rule for this class.
    let primaryDelta: number;
    let primaryThreshold: number;
    let recentDelta: number;
    switch (code) {
      case CLASS.waterGain:
        primaryDelta = b.mndwi[i] - a.mndwi[i];
        primaryThreshold = t.waterGainD;
        recentDelta = bRecent.mndwi[i] - a.mndwi[i];
        break;
      case CLASS.waterLoss:
        primaryDelta = b.mndwi[i] - a.mndwi[i];
        primaryThreshold = t.waterLossD;
        recentDelta = bRecent.mndwi[i] - a.mndwi[i];
        break;
      case CLASS.bareBuilt:
        primaryDelta = b.ndbi[i] - a.ndbi[i];
        primaryThreshold = t.bareBuiltD;
        recentDelta = bRecent.ndbi[i] - a.ndbi[i];
        break;
      default:
        primaryDelta = b.ndvi[i] - a.ndvi[i];
        primaryThreshold = code === CLASS.vegLoss ? t.vegLossD : t.vegGainD;
        recentDelta = bRecent.ndvi[i] - a.ndvi[i];
    }
    const signOk = primaryDelta !== 0 && Math.sign(recentDelta) === Math.sign(primaryDelta);
    const aStable =
      Math.abs(aRecentVal(code, aRecent, i) - driverVal(a, code, i)) <
      Math.abs(primaryThreshold);
    const persistent =
      signOk &&
      aStable &&
      Math.abs(recentDelta) >= VOTE.persistFactor * Math.abs(primaryThreshold);
    persistGrid[i] = persistent ? PERSIST.yes : PERSIST.transient;
    if (persistent) persistentPixels += 1;
    else transientPixels += 1;

    const conf = Math.max(0, Math.min(100, Math.round(prob * 100)));
    confGrid[i] = conf;
    tierGrid[i] = tierFromConf(conf);
    classGrid[i] = code;
    cvaSum += buf[CVA_IDX];
    changePixels += 1;
  }

  return {
    classGrid,
    subGrid,
    tierGrid,
    persistGrid,
    confGrid,
    cvaMean: changePixels > 0 ? cvaSum / changePixels : 0,
    changePixels,
    persistentPixels,
    transientPixels,
  };
}

/** Standardised feature vector for one pixel (exported for tests/tools). */
export function featureVectorAt(
  input: ClassifyFusedInput,
  i: number,
  out?: Float32Array,
): Float32Array {
  return makeFeatureExtractor(input)(i, out);
}
