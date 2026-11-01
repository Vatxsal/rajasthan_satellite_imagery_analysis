/**
 * Phase 6 (#16) — stable event ids and the pure paging/filter core of
 * GET /api/compare/events. Kept dependency-free so the node test runner can
 * exercise exactly what the route runs.
 */
import type { ConfidenceTier } from "./types";

/** Minimum-tier semantics: `high` keeps only high-confidence events, etc. */
const CONFIDENCE_RANK: Record<ConfidenceTier, number> = { low: 1, medium: 2, high: 3 };

export const EVENTS_PAGE_LIMIT_DEFAULT = 100;
export const EVENTS_PAGE_LIMIT_MAX = 500;

/**
 * Deterministic event id (FNV-1a 32-bit, 8 hex chars) over the stable patch
 * fields — the same patch in the same analysis always maps to the same id,
 * and ids never collide between genuinely different patches in practice.
 */
export function eventId(
  classCode: number,
  label: number,
  centroid: number[],
  areaHa: number,
): string {
  const input = `${classCode}|${label}|${(centroid[0] ?? 0).toFixed(6)}|${(centroid[1] ?? 0).toFixed(6)}|${areaHa.toFixed(2)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `ev_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export interface EventPageQuery {
  /** 1…EVENTS_PAGE_LIMIT_MAX (clamped). */
  limit?: number;
  /** 0-based skip into the filtered list (clamped ≥ 0). */
  offset?: number;
  /** Exact class-code filter (e.g. CLASS.vegLoss). */
  classCode?: number;
  /** Minimum confidence tier; events without tiers (engine v1) are excluded. */
  confidence?: ConfidenceTier;
}

export interface EventPage {
  /** Count after filtering, before paging. */
  total: number;
  limit: number;
  offset: number;
  items: GeoJSON.Feature[];
}

function propsOf(feature: GeoJSON.Feature): Record<string, unknown> {
  return (feature.properties ?? {}) as Record<string, unknown>;
}

/** Filter + paginate a patch-vector collection (order = largest first). */
export function pageEvents(features: readonly GeoJSON.Feature[], query: EventPageQuery = {}): EventPage {
  const rawLimit = Number.isFinite(query.limit) ? Math.floor(query.limit as number) : EVENTS_PAGE_LIMIT_DEFAULT;
  const limit = Math.max(1, Math.min(EVENTS_PAGE_LIMIT_MAX, rawLimit));
  const offset = Math.max(0, Math.floor(Number.isFinite(query.offset) ? (query.offset as number) : 0));
  const minRank = query.confidence ? CONFIDENCE_RANK[query.confidence] : 0;

  const filtered = features.filter((feature) => {
    const props = propsOf(feature);
    if (query.classCode !== undefined && Number(props.classCode) !== query.classCode) return false;
    if (minRank > 0) {
      const confidence = props.confidence as ConfidenceTier | undefined;
      if (!confidence) return false;
      if (CONFIDENCE_RANK[confidence] < minRank) return false;
    }
    return true;
  });

  return { total: filtered.length, limit, offset, items: filtered.slice(offset, offset + limit) };
}
