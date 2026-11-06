/**
 * Test-only module resolver for the commonjs test build (`tsconfig.test.json`).
 *
 * Server modules import each other through the "@/…" path alias (tsconfig
 * `paths`), which tsc keeps verbatim in the emitted require() calls — plain
 * node cannot resolve them. This hook maps "@/x" onto the compiled tree
 * (.test-build/x), except ".geojson" assets which tsc never copies and are
 * therefore loaded straight from the source tree (Node learns the extension
 * below). Import this module BEFORE anything that touches the "@/…" graph.
 */
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";

const BUILD_ROOT = path.resolve(__dirname, "..");
const SOURCE_ROOT = path.resolve(__dirname, "..", "..");

interface PatchableModule {
  _resolveFilename: (request: string, ...rest: unknown[]) => string;
  _load: (request: string, ...rest: unknown[]) => unknown;
  _extensions: Record<string, (module: { exports: unknown }, filename: string) => void>;
  __rseAliasHook?: boolean;
}

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
  patched._extensions[".geojson"] = (module, filename) => {
    module.exports = JSON.parse(readFileSync(filename, "utf8"));
  };
  // geotiff's CJS build requires the ESM-only quick-lru (ERR_REQUIRE_ESM
  // under node --test). The guard-flow tests never decode a raster, so the
  // one function lib/analysis/parse.ts imports is stubbed to fail loudly
  // if a test ever reaches actual GeoTIFF parsing.
  const originalLoad = patched._load;
  patched._load = function (this: unknown, request: string, ...rest: unknown[]): unknown {
    if (request === "geotiff") {
      return {
        fromArrayBuffer: () => {
          throw new Error("geotiff is stubbed in the test harness");
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  patched.__rseAliasHook = true;
}
