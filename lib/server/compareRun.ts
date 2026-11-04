/**
 * Stateless compare-analysis core shared by
 * /api/compare/{analyze,events,overlay,summary}.
 *
 * The client's map markers, stats and Events list all come from the analyze
 * response, so the server must never be the only holder of the result: every
 * cache-backed route derives the analysis key from the request parameters
 * and, on a miss, re-runs the analysis (in-flight deduped) instead of failing
 * with a 404 "expired". Only genuinely unknown requests (no parameters) fall
 * back to cache-only.
 */
import { z } from "zod";
import { searchCatalog, type CatalogHit } from "@/lib/cdse/catalog";
import { bboxAreaKm2, type ClipGeometry } from "@/lib/cdse/geometry";
import { runCompare, type CompareStage } from "@/lib/analysis/analyze";
import {
  COMPOSITE_WINDOW_DAYS_DEFAULT,
  COMPOSITE_WINDOW_DAYS_MAX,
  type Sensitivity,
} from "@/lib/analysis/config";
import type {
  CompareEngine,
  CompareInputMode,
  DateSceneMeta,
} from "@/lib/analysis/types";
import { compareCacheKey, compareResultCache, type CompareArtifactEntry } from "@/lib/cache";
import { paramsToQuery } from "@/lib/compare/params";
import { ensureCached } from "@/lib/compare/ensureArtifact";
import { dataSource, getServerEnv } from "@/lib/env";
import { tehsilsFc } from "@/lib/data/boundaries";
import { apiError } from "@/lib/server/api";
import { resolveArea, type ResolvedArea } from "@/lib/server/areas";
// Relative import: test builds compile lib files with commonjs, where the
// "@/lib/…" alias does not resolve at runtime.
import { sharedInstance } from "../singleton";

/** Catalogue fetch cap per date — only existence + best-tile metadata needed. */
const CATALOG_LIMIT = 50;

export const MOCK_SOURCE_MESSAGE =
  "Change detection needs live Sentinel-2 data — set NEXT_PUBLIC_DATA_SOURCE=cdse with CDSE credentials.";

/**
 * Analysis parameters, identical in name to the analyze body — the events,
 * overlay and summary routes accept them (query string or body) to rebuild
 * the key and recompute after a cache miss. Coercions handle strings.
 */
export const compareParamsSchema = z
  .object({
    areaId: z.string().trim().min(1),
    level: z.enum(["district", "tehsil", "ilr"]),
    dateA: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateA must be YYYY-MM-DD"),
    dateB: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "dateB must be YYYY-MM-DD"),
    sensitivity: z.enum(["low", "medium", "high"]).default("medium"),
    minPatchHa: z.coerce.number().min(0.01).max(100).default(0.2),
    /** Engine-v2 input mode (ignored while CHANGE_ENGINE=v1). */
    inputMode: z.enum(["single", "composite"]).default("composite"),
    /** ±days around each date for composite inputs (0-15; 0 = the single day). */
    compositeWindowDays: z.coerce
      .number()
      .int()
      .min(0)
      .max(COMPOSITE_WINDOW_DAYS_MAX)
      .default(COMPOSITE_WINDOW_DAYS_DEFAULT),
  })
  .refine((value) => value.dateA !== value.dateB, {
    message: "Pick two different dates to compare.",
    path: ["dateB"],
  });

export type CompareParams = z.infer<typeof compareParamsSchema>;

/** Catalogue hits for both sides, validated before a run starts. */
export interface SceneHits {
  hitsA: CatalogHit[];
  hitsB: CatalogHit[];
}

/** Everything a recompute needs, derived once from the request. */
export interface ResolvedCompareParams {
  key: string;
  aiEnabled: boolean;
  area: ResolvedArea;
  dateA: string;
  dateB: string;
  sensitivity: Sensitivity;
  minPatchHa: number;
  engine: CompareEngine;
  inputMode: CompareInputMode;
  compositeWindowDays: number;
  maxPx: number;
}

export function sceneMeta(hits: CatalogHit[]): DateSceneMeta {
  const best = hits.reduce((a, b) => (a.cloudCover <= b.cloudCover ? a : b));
  return {
    date: best.date,
    cloudCover: best.cloudCover,
    satellite: best.satellite,
    tileCount: hits.length,
  };
}

/** Tehsil polygons of the selected district (zonal breakdown input); null elsewhere. */
export function districtZones(area: ResolvedArea): Array<{
  id: string;
  name: string;
  geometry: ClipGeometry;
}> | null {
  if (area.level !== "district") return null;
  const zones: Array<{ id: string; name: string; geometry: ClipGeometry }> = [];
  for (const feature of tehsilsFc.features) {
    const props = feature.properties;
    if (!props) continue;
    if (String(props.districtId ?? "") !== area.id) continue;
    if (!feature.geometry) continue;
    zones.push({
      id: String(props.id ?? ""),
      name: String(props.name ?? props.id ?? "Tehsil"),
      geometry: feature.geometry as ClipGeometry,
    });
  }
  return zones.length > 0 ? zones : null;
}

/**
 * Parses + normalises the request into a cache-key-deriving plan.
 * Throws the same HTTP errors the analyze route used to throw pre-stream
 * (mock source, unknown area, oversized AOI), so failures stay plain HTTP.
 */
export function resolveCompareParams(rawBody: unknown): ResolvedCompareParams {
  const env = getServerEnv();
  if (dataSource === "mock") {
    throw apiError(400, "CDSE_CONFIG", MOCK_SOURCE_MESSAGE);
  }

  const body = compareParamsSchema.parse(rawBody);
  // Normalise order: A is always the earlier date.
  const [dateA, dateB] =
    body.dateA < body.dateB ? [body.dateA, body.dateB] : [body.dateB, body.dateA];

  // Engine v1 always runs single-date inputs; v2 honours the request mode.
  const engine = env.CHANGE_ENGINE;
  const inputMode = engine === "v2" ? body.inputMode : "single";
  const compositeWindowDays = inputMode === "composite" ? body.compositeWindowDays : 0;

  const area = resolveArea(body.level, body.areaId);
  if (!area) {
    throw apiError(404, "AREA_NOT_FOUND", "Unknown area for this comparison.");
  }

  const areaKm2 = bboxAreaKm2(area.bbox);
  if (areaKm2 > env.MAX_AOI_KM2) {
    throw apiError(
      400,
      "AOI_TOO_LARGE",
      `Area too large for live imagery (~${Math.round(areaKm2).toLocaleString()} km²). Pick a smaller district, tehsil, or ILR area (limit ${env.MAX_AOI_KM2.toLocaleString()} km²).`,
    );
  }

  const key = compareCacheKey({
    areaId: area.id,
    level: area.level,
    dateA,
    dateB,
    sensitivity: body.sensitivity,
    minPatchHa: body.minPatchHa,
    engine,
    inputMode,
    compositeWindowDays,
  });

  return {
    key,
    aiEnabled: Boolean(env.GEMINI_API_KEY),
    area,
    dateA,
    dateB,
    sensitivity: body.sensitivity,
    minPatchHa: body.minPatchHa,
    engine,
    inputMode,
    compositeWindowDays,
    maxPx: env.COMPARE_MAX_PX,
  };
}

/** Query-string form of the analysis parameters — embedded in overlayUrl so
 *  every consumer (map image source, exports) can recompute statelessly.
 *  Delegates to the client's shared serializer so both sides always send the
 *  exact field set the key is derived from. */
export function compareParamsQueryString(resolved: ResolvedCompareParams): string {
  return paramsToQuery({
    areaId: resolved.area.id,
    level: resolved.area.level,
    dateA: resolved.dateA,
    dateB: resolved.dateB,
    sensitivity: resolved.sensitivity,
    minPatchHa: resolved.minPatchHa,
    inputMode: resolved.inputMode,
    compositeWindowDays: resolved.compositeWindowDays,
  }).toString();
}

/**
 * The client carries a key from the analyze response; a caller that also
 * supplies parameters must prove they re-derive that key (tampering or a
 * stale metadata mismatch surfaces as 400, never as a wrong-result merge).
 */
export function assertKeyMatches(requested: string, derived: string): void {
  if (requested !== derived) {
    throw apiError(
      400,
      "KEY_PARAMS_MISMATCH",
      "Analysis parameters don't match this result key. Re-run the comparison.",
    );
  }
}

/** Validates both dates exist over the area (also pre-warms the CDSE token). */
export async function validateScenes(resolved: ResolvedCompareParams): Promise<SceneHits> {
  const hitsA = await searchCatalog({
    bbox: resolved.area.bbox,
    from: resolved.dateA,
    to: resolved.dateA,
    maxCloud: 100,
    limit: CATALOG_LIMIT,
  });
  if (hitsA.length === 0) {
    throw apiError(
      404,
      "COMPARE_NO_SCENE",
      `No Sentinel-2 scene on ${resolved.dateA} over ${resolved.area.name}.`,
    );
  }
  const hitsB = await searchCatalog({
    bbox: resolved.area.bbox,
    from: resolved.dateB,
    to: resolved.dateB,
    maxCloud: 100,
    limit: CATALOG_LIMIT,
  });
  if (hitsB.length === 0) {
    throw apiError(
      404,
      "COMPARE_NO_SCENE",
      `No Sentinel-2 scene on ${resolved.dateB} over ${resolved.area.name}.`,
    );
  }
  return { hitsA, hitsB };
}

/** Concurrent recomputes of one key share a single run (restart + Load more
 *  + a summary probe can race after the same cold cache). */
const inflight = sharedInstance<Map<string, Promise<CompareArtifactEntry>>>(
  "rse.compareInflight",
  () => new Map<string, Promise<CompareArtifactEntry>>(),
);

export interface EnsureCompareOptions {
  /** Streams stage frames while this call is the one actually running. */
  onStage?: (stage: CompareStage) => void;
  /** Catalogue hits already validated by the caller — the analyze route
   *  validates pre-stream so scene errors stay HTTP errors, not frames. */
  sceneHits?: SceneHits;
}

/**
 * Cache-first artifact access with stateless recompute on a miss
 * (hit/miss + in-flight dedupe live in ensureCached — unit-tested there).
 * Returns the hit flag so streaming callers can fake stage frames.
 */
export async function ensureCompare(
  resolved: ResolvedCompareParams,
  options: EnsureCompareOptions = {},
): Promise<{ entry: CompareArtifactEntry; hit: boolean }> {
  const { value, hit } = await ensureCached(
    compareResultCache,
    resolved.key,
    async (): Promise<CompareArtifactEntry> => {
      const hits = options.sceneHits ?? (await validateScenes(resolved));
      const artifact = await runCompare(
        {
          geometry: resolved.area.geometry,
          dateA: resolved.dateA,
          dateB: resolved.dateB,
          areaName: resolved.area.name,
          areaLevel: resolved.area.level,
          areaId: resolved.area.id,
          sensitivity: resolved.sensitivity,
          minPatchHa: resolved.minPatchHa,
          maxPx: resolved.maxPx,
          sceneA: sceneMeta(hits.hitsA),
          sceneB: sceneMeta(hits.hitsB),
          zones: districtZones(resolved.area),
          engine: resolved.engine,
          inputMode: resolved.inputMode,
          compositeWindowDays: resolved.compositeWindowDays,
        },
        options.onStage,
      );
      return {
        stats: artifact.result,
        overlayPng: artifact.overlayPng,
        classGz: artifact.classGz,
        width: artifact.width,
        height: artifact.height,
        bbox: artifact.bbox,
        geometry: resolved.area.geometry,
        events: artifact.patchVectors,
      };
    },
    { inflight, ttlSeconds: getServerEnv().IMAGERY_CACHE_TTL_SECONDS },
  );
  return { entry: value, hit };
}

/**
 * Entry accessor for cache-backed routes: parameters present → stateless
 * recompute path; absent (legacy callers) → cache-only, preserving the old
 * 404 "expired" contract for genuinely key-only requests.
 */
export async function entryForKey(
  requestedKey: string,
  rawParams: unknown,
): Promise<CompareArtifactEntry> {
  const hasParams =
    !!rawParams &&
    typeof rawParams === "object" &&
    typeof (rawParams as { areaId?: unknown }).areaId === "string" &&
    (rawParams as { areaId: string }).areaId.length > 0;

  if (hasParams) {
    const resolved = resolveCompareParams(rawParams);
    assertKeyMatches(requestedKey, resolved.key);
    const { entry } = await ensureCompare(resolved);
    return entry;
  }

  const cached = compareResultCache.get(requestedKey);
  if (!cached) {
    throw apiError(
      404,
      "ANALYSIS_EXPIRED",
      "This comparison is no longer cached on the server. Run the analysis again to get a summary.",
    );
  }
  return cached;
}
