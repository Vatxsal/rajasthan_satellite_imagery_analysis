/**
 * Real-data SHARPEN_SWIR measurement — edge sharpness before/after the
 * regression SWIR sharpening on ONE live Sentinel-2 composite.
 *
 * Usage:  npm run sharpen:measure
 * Env:    .env / .env.local CDSE credentials (same as the app).
 *
 * Fetches a small Jaipur bbox composite (±7 d window), decodes the 12-band
 * FLOAT32 GeoTIFF, runs sharpenSwir on a copy, and prints:
 *   - fit R² + applied flags per band (side A),
 *   - edge sharpness (mean |∇| ×1000) of B11/B12 before vs after,
 *   - B08 (10 m native) as the sharpness reference,
 *   - NDBI gradient before vs after (the classification input that matters).
 *
 * Implementation notes (plain `node` constraints):
 *   - "@/…" modules need an alias resolver — the same mapping as
 *     scripts/alias-hook.ts, inlined here WITHOUT its geotiff stub;
 *   - parse.ts's `require("geotiff")` fails on Node 20 (geotiff's CJS build
 *     requires the ESM-only quick-lru), so the GeoTIFF is decoded through a
 *     dynamic ESM import instead — the band mapping mirrors
 *     parseCompositeRaster (lib/analysis/parse.ts) exactly.
 *   - Static imports would hoist above the alias patch, so everything but
 *     node builtins loads through req()/importEsm() after the patch runs.
 */
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";

/* ------------------------------------------------------------------ */
/* @/ alias resolver (mirrors scripts/alias-hook.ts, geotiff NOT stubbed) */
/* ------------------------------------------------------------------ */

interface PatchableModule {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
  __rseAliasHook?: boolean;
}

const BUILD_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.resolve(__dirname, "..", "..");

const patched = Module as unknown as PatchableModule;
if (!patched.__rseAliasHook) {
  const originalResolve = patched._resolveFilename;
  patched._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
    if (request.startsWith("@/")) {
      const rel = request.slice(2);
      request = rel.endsWith(".geojson")
        ? path.join(SOURCE_ROOT, rel)
        : path.join(BUILD_ROOT, rel);
    }
    return originalResolve.call(this, request, ...rest);
  };
  patched.__rseAliasHook = true;
}

function req<T>(spec: string): T {
  return require(spec) as T;
}

async function importEsm<T>(spec: string): Promise<T> {
  // Dynamic import from CJS — TS would downlevel `import()` to require().
  const dynamicImport = new Function("s", "return import(s)") as (s: string) => Promise<T>;
  return dynamicImport(spec);
}

/* ------------------------------------------------------------------ */
/* .env loader (mirrors scripts/send-test-report.ts)                   */
/* ------------------------------------------------------------------ */

function loadLocalEnv(): void {
  for (const file of [".env", ".env.local"]) {
    const filePath = path.join(process.cwd(), file);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      let value = rawValue.trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

/** Mean |gradient| over interior pixels (mean |dx| + mean |dy|). */
function gradMean(a: Float32Array, w: number, h: number): number {
  let sx = 0;
  let nx = 0;
  let sy = 0;
  let ny = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w) {
        sx += Math.abs(a[i + 1] - a[i]);
        nx += 1;
      }
      if (y + 1 < h) {
        sy += Math.abs(a[i + w] - a[i]);
        ny += 1;
      }
    }
  }
  return sx / nx + sy / ny;
}

function pct(before: number, after: number): string {
  if (before === 0) return "n/a";
  return `${(((after - before) / before) * 100).toFixed(0)}%`;
}

function row(name: string, before: number, after: number | null): string {
  const b = (before * 1000).toFixed(2);
  const a = after === null ? "  —  " : (after * 1000).toFixed(2);
  const d = after === null ? "" : pct(before, after);
  return `  ${name.padEnd(6)} ${b.padStart(8)} ${a.padStart(8)} ${d.padStart(7)}`;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const BBOX: [number, number, number, number] = [75.75, 26.85, 75.85, 26.95]; // Jaipur mix
const DATE_A = "2026-11-04";
const DATE_B = "2026-10-20";
const WINDOW_DAYS = 7;

interface GeotiffModule {
  fromArrayBuffer: (ab: ArrayBuffer) => Promise<{
    getImage: () => Promise<{
      getWidth: () => number;
      getHeight: () => number;
      readRasters: (opts: { width: number; height: number; samples: number[] }) => Promise<unknown>;
    }>;
  }>;
}

async function main(): Promise<void> {
  loadLocalEnv();

  const fetchMod = req<typeof import("../lib/analysis/fetch")>("../lib/analysis/fetch");
  const v2 = req<typeof import("../lib/analysis/v2")>("../lib/analysis/v2");
  const sharpenMod = req<typeof import("../lib/analysis/sharpen")>("../lib/analysis/sharpen");
  const geometry = req<typeof import("../lib/cdse/geometry")>("../lib/cdse/geometry");

  const geometryPolygon: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [
      [
        [BBOX[0], BBOX[1]],
        [BBOX[2], BBOX[1]],
        [BBOX[2], BBOX[3]],
        [BBOX[0], BBOX[3]],
        [BBOX[0], BBOX[1]],
      ],
    ],
  };
  const size = geometry.computeOutputSize(BBOX, 768);
  console.log(
    `fetching composite ${DATE_A} (±${WINDOW_DAYS} d, other ${DATE_B}) over [${BBOX.join(", ")}] → ${size.width}×${size.height} …`,
  );
  const started = Date.now();
  const buffer = await fetchMod.fetchCompareCompositeRaster(
    geometryPolygon,
    DATE_A,
    BBOX,
    size,
    WINDOW_DAYS,
    DATE_B,
  );
  console.log(`fetched ${(buffer.byteLength / 1024).toFixed(0)} KiB in ${((Date.now() - started) / 1000).toFixed(1)} s`);

  // Decode via the ESM geotiff build (CJS require fails on Node 20);
  // band mapping mirrors parseCompositeRaster (lib/analysis/parse.ts).
  const geotiff = await importEsm<GeotiffModule>("geotiff");
  const tiff = await geotiff.fromArrayBuffer(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const bands = (await image.readRasters({
    width,
    height,
    samples: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  })) as Float32Array[];
  const n = width * height;
  const valid = new Uint8Array(n);
  for (let i = 0; i < n; i++) valid[i] = bands[7][i] >= 1 ? 1 : 0;
  const parsed: import("../lib/analysis/parse").ParsedCompositeRaster = {
    width,
    height,
    b02: bands[0],
    b03: bands[1],
    b04: bands[2],
    b05: bands[3],
    b08: bands[4],
    b11: bands[5],
    b12: bands[6],
    valid,
    obsCount: bands[7],
    scl: bands[8],
    recentNdvi: bands[9],
    recentMndwi: bands[10],
    recentNdbi: bands[11],
  };

  let validPct = 0;
  for (let i = 0; i < n; i++) validPct += valid[i];
  validPct = (100 * validPct) / n;

  const before11 = Float32Array.from(parsed.b11);
  const before12 = Float32Array.from(parsed.b12);
  const ndbiBefore = v2.deriveV2Indices(parsed).ndbi;

  const fit = sharpenMod.sharpenSwir(parsed, width, height, parsed.valid);

  const after11 = parsed.b11;
  const after12 = parsed.b12;
  const ndbiAfter = v2.deriveV2Indices(parsed).ndbi;

  let maxDetail = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(after11[i] - before11[i]);
    if (d > maxDetail) maxDetail = d;
  }

  const gB11 = gradMean(before11, width, height);
  const gA11 = gradMean(after11, width, height);
  const gB12 = gradMean(before12, width, height);
  const gA12 = gradMean(after12, width, height);
  const g08 = gradMean(parsed.b08, width, height);
  const gNdbiB = gradMean(ndbiBefore, width, height);
  const gNdbiA = gradMean(ndbiAfter, width, height);

  console.log(`grid ${width}×${height} valid=${validPct.toFixed(1)}%`);
  console.log(
    `fit: B11 r2=${fit.b11.r2.toFixed(3)} applied=${fit.b11.applied} | ` +
      `B12 r2=${fit.b12.r2.toFixed(3)} applied=${fit.b12.applied}`,
  );
  console.log(`max |ΔB11| added = ${maxDetail.toFixed(4)} (clamp ${sharpenMod.SHARPEN_DETAIL_CLAMP})`);
  console.log("edge sharpness mean |∇| ×1000:");
  console.log("  band      before     after       Δ");
  console.log(row("B11", gB11, gA11));
  console.log(row("B12", gB12, gA12));
  console.log(row("B08", g08, null) + "   (10 m native reference, never sharpened)");
  console.log(row("NDBI", gNdbiB, gNdbiA) + "   (classification input)");
}

main().catch((err: unknown) => {
  console.error("sharpen:measure failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
