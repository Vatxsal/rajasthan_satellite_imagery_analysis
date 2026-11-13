#!/usr/bin/env node
/**
 * Generates the /login landing swipe pair from Sentinel-2 L2A via the
 * Copernicus Data Space Process API (same endpoints as lib/cdse/*):
 *
 *   public/landing/sambhar-before.jpg   (earlier date)
 *   public/landing/sambhar-after.jpg    (later date)
 *   data/landing/swipe.json             build-time fact sheet for the page
 *
 * The script probes a handful of low-cloud scenes across three seasonal
 * windows (monsoon fill / post-monsoon recession / pre-monsoon dry),
 * scores each pair by the change in dark-pixel fraction (Sambhar's water
 * is dark, the salt bed is bright), then renders the winning pair at
 * 1600 px wide and encodes AVIF via ImageMagick (≤ 120 KB; falls back to
 * a blurred JPEG when ImageMagick is unavailable). Also emits a
 * center-cropped og:image JPEG.
 *
 * Usage:  node scripts/landing-swipe.mjs
 *         node scripts/landing-swipe.mjs --bbox=74.85,26.80,75.40,27.15
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";

const run = promisify(execFile);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "public", "landing");
const FACTS_FILE = path.join(ROOT, "data", "landing", "swipe.json");

const TRUE_COLOR = `//VERSION=3
function setup() {
  return {
    input: [{ bands: ["B04", "B03", "B02", "dataMask"] }],
    mosaicking: "ORBIT",
    output: { bands: 4, sampleType: "AUTO" },
  };
}
function evaluatePixel(samples) {
  for (const s of samples) {
    if (s.dataMask === 1) return [s.B04 * 2.5, s.B03 * 2.5, s.B02 * 2.5, 1];
  }
  return [0, 0, 0, 0];
}`;

const MAX_JPEG_BYTES = 120_000;
const FINAL_LONG_SIDE = 1600;
const PROBE_LONG_SIDE = 512;
/** Minimum |Δdark fraction| between the two dates to call the change "obvious". */
const MIN_DARK_DELTA = 0.04;

// --------------------------------------------------------------- utilities

function loadLocalEnv() {
  const file = path.join(ROOT, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

function parseBBoxArg() {
  const arg = process.argv.find((a) => a.startsWith("--bbox="));
  if (!arg) return null;
  const parts = arg.slice("--bbox=".length).split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`Invalid --bbox: ${arg}`);
  }
  return parts;
}

async function fetchJson(url, init, timeoutMs = 30_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} at ${url}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text);
}

// ------------------------------------------------------------------ CDSE

async function getToken() {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.CDSE_CLIENT_ID ?? "",
    client_secret: process.env.CDSE_CLIENT_SECRET ?? "",
  });
  const response = await fetch(process.env.CDSE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`token request failed: HTTP ${response.status}`);
  const json = await response.json();
  if (!json.access_token) throw new Error("token response was malformed");
  return json.access_token;
}

async function searchScenes(token, { bbox, from, to, maxCloud, limit = 12 }) {
  const json = await fetchJson(`${process.env.CDSE_SH_BASE_URL}/catalog/v1/search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bbox,
      datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
      collections: ["sentinel-2-l2a"],
      filter: {
        op: "<=",
        args: [{ property: "eo:cloud_cover" }, maxCloud],
      },
      "filter-lang": "cql2-json",
      limit,
    }),
  });
  const byDate = new Map();
  for (const f of json.features ?? []) {
    if (!f.id || !f.properties?.datetime) continue;
    const date = f.properties.datetime.slice(0, 10);
    const cloudCover = f.properties["eo:cloud_cover"] ?? 0;
    const existing = byDate.get(date);
    if (!existing || cloudCover < existing.cloudCover) {
      byDate.set(date, { id: f.id, date, cloudCover });
    }
  }
  return [...byDate.values()].sort((a, b) => a.cloudCover - b.cloudCover);
}

function computeOutputSize(bbox, maxSize) {
  const [west, south, east, north] = bbox;
  const midLatRad = ((south + north) / 2) * (Math.PI / 180);
  const widthDeg = Math.max(1e-6, Math.abs(east - west)) * Math.cos(midLatRad);
  const heightDeg = Math.max(1e-6, Math.abs(north - south));
  if (widthDeg >= heightDeg) {
    return { width: maxSize, height: Math.max(1, Math.round((maxSize * heightDeg) / widthDeg)) };
  }
  return { height: maxSize, width: Math.max(1, Math.round((maxSize * widthDeg) / heightDeg)) };
}

function bboxPolygon(bbox) {
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

async function renderScene(token, { bbox, date, longSide }) {
  const { width, height } = computeOutputSize(bbox, longSide);
  const response = await fetch(`${process.env.CDSE_SH_BASE_URL}/api/v1/process`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "image/png",
    },
    body: JSON.stringify({
      input: {
        bounds: {
          properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" },
          geometry: bboxPolygon(bbox),
        },
        data: [
          {
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: {
                from: `${date}T00:00:00Z`,
                to: `${date}T23:59:59Z`,
              },
            },
            processing: { upsampling: "BICUBIC", downsampling: "BILINEAR" },
          },
        ],
      },
      output: {
        width,
        height,
        responses: [{ identifier: "default", format: { type: "image/png" } }],
      },
      evalscript: TRUE_COLOR,
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`render ${date} failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength === 0) throw new Error(`render ${date} returned an empty body`);
  return PNG.sync.read(buffer);
}

// ---------------------------------------------------------------- metrics

/**
 * Probe metrics: dark fraction (water is dark, salt bed bright), coverage
 * (guards against partial-tile scenes), and a coarse ASCII density map so
 * the dark region's SHAPE can be eyeballed in the terminal (the lake should
 * sit inside the frame, not hug one edge).
 */
function probeMetrics(png) {
  const { data, width, height } = png;
  let covered = 0;
  let dark = 0;
  let lumSum = 0;
  const gridW = 48;
  const gridH = Math.max(8, Math.round((gridW * height) / width / 2));
  const grid = Array.from({ length: gridH }, () =>
    Array.from({ length: gridW }, () => ({ n: 0, d: 0 })),
  );
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    if (data[i + 3] < 128) continue;
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    covered += 1;
    lumSum += lum;
    const isDark = lum < 110;
    if (isDark) dark += 1;
    const gx = Math.min(gridW - 1, Math.max(0, Math.floor((p % width) * gridW / width)));
    const gy = Math.min(gridH - 1, Math.max(0, Math.floor(Math.floor(p / width) * gridH / height)));
    const cell = grid[gy][gx];
    cell.n += 1;
    if (isDark) cell.d += 1;
  }
  const total = width * height;
  const ascii = grid
    .map((row) => row.map((c) => (c.n === 0 ? " " : c.d / c.n > 0.6 ? "#" : c.d / c.n > 0.3 ? "+" : ".")).join(""))
    .join("\n");
  return {
    dark: covered === 0 ? 0 : dark / covered,
    coverage: covered / total,
    meanLum: covered === 0 ? 0 : lumSum / covered,
    ascii,
  };
}

function meanAbsDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  let sum = 0;
  let n = 0;
  const da = a.data;
  const db = b.data;
  for (let i = 0; i < da.length; i += 4) {
    if (da[i + 3] < 128 || db[i + 3] < 128) continue;
    sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    n += 3;
  }
  return n === 0 ? 0 : sum / n;
}

// ------------------------------------------------------------ JPEG output

/** Separable 3×3 box blur on RGB (alpha preserved) — calms Sentinel-2 noise
 *  so the JPEG encoder spends bytes on the image, not on grain. */
function boxBlur3(png) {
  const { width, height } = png;
  const src = png.data;
  const tmp = Buffer.alloc(src.length);
  const out = Buffer.alloc(src.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const x0 = Math.max(0, x - 1) * 4;
      const x1 = x * 4;
      const x2 = Math.min(width - 1, x + 1) * 4;
      const row = y * width * 4;
      for (let c = 0; c < 3; c += 1) {
        // 3-tap average with round-to-nearest (+1)/3 (Buffer truncates).
        tmp[i + c] = (src[row + x0 + c] + src[row + x1 + c] + src[row + x2 + c] + 1) / 3;
      }
      tmp[i + 3] = src[i + 3];
    }
  }
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - 1) * width * 4;
    const y1 = y * width * 4;
    const y2 = Math.min(height - 1, y + 1) * width * 4;
    for (let x = 0; x < width; x += 1) {
      const i = y1 + x * 4;
      for (let c = 0; c < 3; c += 1) {
        out[i + c] = (tmp[y0 + x * 4 + c] + tmp[i + c] + tmp[y2 + x * 4 + c] + 1) / 3;
      }
      out[i + 3] = tmp[i + 3];
    }
  }
  png.data = out;
  return png;
}

/** Area-average downsample (proper box filter) to `longSide` on the long edge. */
function downsample(png, longSide) {
  const { width, height, data } = png;
  const scale = Math.min(1, longSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const sy0 = Math.floor((y * height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x += 1) {
      const sx0 = Math.floor((x * width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const i = (sy * width + sx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          a += data[i + 3];
          n += 1;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

function encodeOnce(png, maxBytes) {
  let best = null;
  for (const quality of [88, 84, 80, 76, 72, 68, 64, 60, 56, 52]) {
    const encoded = jpeg.encode({ data: png.data, width: png.width, height: png.height }, quality);
    if (!best || encoded.data.length < best.data.length) {
      best = { data: encoded.data, quality, width: png.width, height: png.height };
    }
    if (encoded.data.length <= maxBytes) return { data: encoded.data, quality, width: png.width, height: png.height };
  }
  return best; // smallest found — caller decides whether it is good enough
}

function encodeJpegWithinBudget(png, maxBytes) {
  // Pass 1: blur in place at native size (1600 px) — the preferred output.
  const blurred = boxBlur3(boxBlur3({ ...png, data: Buffer.from(png.data) }));
  let result = encodeOnce(blurred, maxBytes);
  if (result.data.length <= maxBytes) return { ...result, bytes: result.data.length };

  // Pass 2+: downsample (area average = extra blur), re-encode.
  for (const size of [1440, 1280]) {
    const smaller = boxBlur3(downsample(png, size));
    result = encodeOnce(smaller, maxBytes);
    if (result.data.length <= maxBytes) return { ...result, bytes: result.data.length };
  }
  throw new Error(`JPEG still ${result.data.length} bytes after blur + downsample — needs manual tuning`);
}

// ------------------------------------------------- AVIF (ImageMagick path)

/**
 * Preferred encoder: ImageMagick (libaom/libheif) produces AVIF well under
 * the byte budget at the full 1600 px width, where pure-JS JPEG cannot.
 * Measured on this site: quality 36 ≈ 115 KB @ 1600×1142, PSNR ≈ 30 dB.
 * Returns null when ImageMagick is unavailable so callers can fall back.
 */
async function encodeAvifWithinBudget(pngPath, avifPath, maxBytes) {
  for (const quality of [36, 34, 32]) {
    try {
      await run("magick", [pngPath, "-quality", String(quality), avifPath]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ENOENT|not recognized|not found/i.test(message)) return null; // no magick
      throw new Error(`magick q${quality} failed: ${message.slice(0, 200)}`);
    }
    const bytes = fs.statSync(avifPath).size;
    if (bytes <= maxBytes) return { bytes, quality };
    console.log(`  avif q${quality} = ${bytes} bytes > ${maxBytes}, stepping down`);
  }
  return { bytes: fs.statSync(avifPath).size, quality: 32 };
}

/** Center-cropped 1200×630 JPEG for og:image (crawler-only, not loaded by the page). */
async function encodeOgJpeg(pngPath, ogPath) {
  await run("magick", [
    pngPath,
    "-resize",
    "1200x",
    "-gravity",
    "center",
    "-extent",
    "1200x630",
    "-strip",
    "-quality",
    "74",
    ogPath,
  ]);
  return fs.statSync(ogPath).size;
}

// ------------------------------------------------------------------ main

async function main() {
  loadLocalEnv();
  for (const key of ["CDSE_CLIENT_ID", "CDSE_CLIENT_SECRET", "CDSE_TOKEN_URL", "CDSE_SH_BASE_URL"]) {
    if (!process.env[key]) throw new Error(`missing ${key} (checked environment and .env.local)`);
  }

  const bbox = parseBBoxArg() ?? [74.85, 26.8, 75.4, 27.15];
  console.log(`site bbox: ${bbox.join(", ")}`);

  const token = await getToken();
  console.log("token acquired");

  const windows = [
    { label: "monsoon", from: "2026-06-25", to: "2026-09-15", maxCloud: 25, take: 3 },
    { label: "post-monsoon", from: "2026-10-01", to: "2026-11-10", maxCloud: 15, take: 2 },
    { label: "pre-monsoon", from: "2026-04-15", to: "2026-05-31", maxCloud: 15, take: 2 },
  ];

  const candidates = [];
  for (const window of windows) {
    const hits = await searchScenes(token, { bbox, ...window });
    console.log(
      `${window.label} ${window.from}→${window.to}: ${hits.length} hits ≤${window.maxCloud}% cloud; probing top ${Math.min(window.take, hits.length)}`,
    );
    for (const hit of hits.slice(0, window.take)) {
      const png = await renderScene(token, { bbox, date: hit.date, longSide: PROBE_LONG_SIDE });
      const m = probeMetrics(png);
      console.log(
        `  probe ${hit.date} cloud=${hit.cloudCover.toFixed(1)}% dark=${(m.dark * 100).toFixed(1)}% ` +
          `coverage=${(m.coverage * 100).toFixed(1)}% meanLum=${m.meanLum.toFixed(0)}`,
      );
      console.log(
        m.ascii
          .split("\n")
          .map((line) => `    |${line}|`)
          .join("\n"),
      );
      if (m.coverage < 0.97) {
        console.log(`    ↳ skipped: partial-tile coverage`);
        continue;
      }
      candidates.push({ ...hit, window: window.label, dark: m.dark, coverage: m.coverage, meanLum: m.meanLum, png });
    }
  }

  if (candidates.length < 2) throw new Error("not enough scenes to build a pair");

  // Best pair = largest dark-fraction change; ties → lowest combined cloud.
  let best = null;
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i];
      const b = candidates[j];
      const delta = Math.abs(a.dark - b.dark);
      const cloud = a.cloudCover + b.cloudCover;
      if (!best || delta > best.delta + 1e-9 || (Math.abs(delta - best.delta) < 1e-9 && cloud < best.cloud)) {
        best = { a, b, delta, cloud };
      }
    }
  }

  const [before, after] = best.a.date <= best.b.date ? [best.a, best.b] : [best.b, best.a];
  console.log(
    `best pair: ${before.date} (${before.window}, ${before.cloudCover.toFixed(1)}% cloud) → ` +
      `${after.date} (${after.window}, ${after.cloudCover.toFixed(1)}% cloud); ` +
      `Δdark=${(best.delta * 100).toFixed(1)}pp`,
  );
  if (best.delta < MIN_DARK_DELTA) {
    console.error(
      `FAIL: Δdark ${(best.delta * 100).toFixed(1)}pp < ${MIN_DARK_DELTA * 100}pp — ` +
        `the lake is likely outside the bbox; adjust --bbox and re-run.`,
    );
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "artifacts"), { recursive: true });
  fs.mkdirSync(path.dirname(FACTS_FILE), { recursive: true });

  const pair = [];
  let og = null;
  for (const [slot, scene] of [["before", before], ["after", after]]) {
    const png = await renderScene(token, { bbox, date: scene.date, longSide: FINAL_LONG_SIDE });
    const pngPath = path.join(ROOT, "artifacts", `landing-${slot}.png`);
    fs.writeFileSync(pngPath, PNG.sync.write(png));

    // Preferred: AVIF via ImageMagick (fits the budget at full width).
    const avifPath = path.join(OUT_DIR, `sambhar-${slot}.avif`);
    const avif = await encodeAvifWithinBudget(pngPath, avifPath, MAX_JPEG_BYTES);

    let file;
    let format;
    let bytes;
    let quality;
    let width = png.width;
    let height = png.height;
    if (avif) {
      file = `/landing/sambhar-${slot}.avif`;
      format = "avif";
      bytes = avif.bytes;
      quality = avif.quality;
    } else {
      const fallback = encodeJpegWithinBudget(png, MAX_JPEG_BYTES);
      const jpgPath = path.join(OUT_DIR, `sambhar-${slot}.jpg`);
      fs.writeFileSync(jpgPath, fallback.data);
      file = `/landing/sambhar-${slot}.jpg`;
      format = "jpeg";
      bytes = fallback.data.length;
      quality = fallback.quality;
      width = fallback.width;
      height = fallback.height;
      fs.rmSync(avifPath, { force: true });
    }
    console.log(
      `wrote public/landing/sambhar-${slot}.${format === "avif" ? "avif" : "jpg"} — ` +
        `${width}×${height} q${quality} ${(bytes / 1024).toFixed(0)} KB`,
    );
    pair.push({
      slot,
      date: scene.date,
      cloudCover: Number(scene.cloudCover.toFixed(1)),
      window: scene.window,
      width,
      height,
      bytes,
      quality,
      format,
      dark: Number(scene.dark.toFixed(4)),
      file,
    });

    if (slot === "before") {
      // OG image from the same PNG (crawler-only asset, not loaded by users).
      const ogPath = path.join(OUT_DIR, "og-swipe.jpg");
      try {
        const ogBytes = await encodeOgJpeg(pngPath, ogPath);
        og = { file: "/landing/og-swipe.jpg", width: 1200, height: 630, bytes: ogBytes };
        console.log(`wrote public/landing/og-swipe.jpg — 1200×630 ${(ogBytes / 1024).toFixed(0)} KB`);
      } catch (error) {
        console.warn(`OG encode skipped: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  const facts = {
    site: "Sambhar Lake",
    bbox,
    credit: "Contains modified Copernicus Sentinel data 2026",
    collection: "sentinel-2-l2a",
    before: pair[0],
    after: pair[1],
    og,
    metrics: {
      darkDeltaPp: Number((best.delta * 100).toFixed(1)),
      meanAbsDiff: Number(meanAbsDiff(before.png, after.png).toFixed(1)),
    },
    generatedAt: new Date().toISOString().slice(0, 10),
  };
  fs.writeFileSync(FACTS_FILE, `${JSON.stringify(facts, null, 2)}\n`);
  console.log(`wrote ${path.relative(ROOT, FACTS_FILE)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
