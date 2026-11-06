/**
 * Deep links that reopen an emailed report:
 *
 *   {origin}/?a=<areaId>&l=<level>&A=<dateA>&B=<dateB>&s=<sensitivity>
 *            &m=<minPatchHa>&im=<inputMode>&tab=events&e=<eventId>
 *
 * Parameters only — never an analysisKey or anything secret. The loader
 * (components/ShareLinkLoader) re-derives everything through the normal
 * user flow (select area → set pair → run), so a tampered or stale link
 * either validates into a legitimate recomputation or is ignored with a
 * toast; it can never inject results.
 */
import { z } from "zod";

/** Stable event id shape produced by lib/analysis/events.ts (eventId()). */
export const SHARE_EVENT_ID_PATTERN = /^ev_[0-9a-f]{8}$/;

/** Area ids look like `d-churu`, `t-jaipur-amber`, `t-jaipur-amber-ilr1`. */
const AREA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Compare tabs the link may open; `events` is the email-facing alias of `hotspots`. */
export type ShareTab = "swipe" | "change-map" | "statistics" | "hotspots" | "summary";

const tabSchema = z
  .enum(["swipe", "change-map", "statistics", "hotspots", "summary", "events"])
  .transform((value): ShareTab => (value === "events" ? "hotspots" : value));

/**
 * The full validated payload of a share link. Short keys are the wire
 * format (they appear in every email); this shape is the parsed form.
 */
export interface ShareLink {
  areaId: string;
  level: "district" | "tehsil" | "ilr";
  dateA: string;
  dateB: string;
  sensitivity: "low" | "medium" | "high";
  minPatchHa: number;
  inputMode: "single" | "composite";
  tab: ShareTab;
  eventId: string | null;
}

const shareSchema = z
  .object({
    a: z.string().regex(AREA_ID_PATTERN, "unknown area"),
    l: z.enum(["district", "tehsil", "ilr"]),
    A: z.string().regex(DATE_PATTERN, "dateA must be YYYY-MM-DD"),
    B: z.string().regex(DATE_PATTERN, "dateB must be YYYY-MM-DD"),
    s: z.enum(["low", "medium", "high"]).default("medium"),
    m: z.coerce.number().min(0.01).max(100).default(0.2),
    im: z.enum(["single", "composite"]).default("composite"),
    tab: tabSchema.default("hotspots"),
    e: z.string().regex(SHARE_EVENT_ID_PATTERN, "bad event id").optional(),
  })
  .refine((value) => value.A !== value.B, { message: "Pick two different dates" })
  .refine((value) => isRealIsoDay(value.A) && isRealIsoDay(value.B), {
    message: "date must be a real calendar day",
  });

function isRealIsoDay(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time)) return false;
  return new Date(time).toISOString().slice(0, 10) === value;
}

/**
 * Parses a location search string ("?a=…&l=…"). Returns null for anything
 * malformed — callers treat null as "no valid report link" and must not run.
 * A search without an `a` param is also null (a plain visit, not a link).
 */
export function parseShareLink(search: string): ShareLink | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has("a")) return null;
  const parsed = shareSchema.safeParse({
    a: params.get("a"),
    l: params.get("l"),
    A: params.get("A"),
    B: params.get("B"),
    s: params.get("s") ?? undefined,
    m: params.get("m") ?? undefined,
    im: params.get("im") ?? undefined,
    tab: params.get("tab") ?? undefined,
    e: params.get("e") ?? undefined,
  });
  if (!parsed.success) return null;
  const value = parsed.data;
  return {
    areaId: value.a,
    level: value.l,
    dateA: value.A,
    dateB: value.B,
    sensitivity: value.s,
    minPatchHa: value.m,
    inputMode: value.im,
    tab: value.tab,
    eventId: value.e ?? null,
  };
}

export interface BuildShareUrlOptions {
  tab?: ShareTab | "events";
  eventId?: string;
}

/**
 * Builds the canonical link for an analysis (used by the email route).
 * `origin` is the site origin (scheme + host) from NEXT_PUBLIC_SITE_URL —
 * never a path. All key-affecting parameters ride along so the recomputed
 * analysis derives the identical cache key (and therefore identical
 * deterministic event ids).
 */
export function buildShareUrl(
  origin: string,
  params: {
    areaId: string;
    level: ShareLink["level"];
    dateA: string;
    dateB: string;
    sensitivity: ShareLink["sensitivity"];
    minPatchHa: number;
    inputMode: ShareLink["inputMode"];
  },
  options: BuildShareUrlOptions = {},
): string {
  const query = new URLSearchParams();
  query.set("a", params.areaId);
  query.set("l", params.level);
  query.set("A", params.dateA);
  query.set("B", params.dateB);
  query.set("s", params.sensitivity);
  query.set("m", String(params.minPatchHa));
  query.set("im", params.inputMode);
  query.set("tab", options.tab ?? "events");
  if (options.eventId) query.set("e", options.eventId);
  return `${origin.replace(/\/+$/, "")}/?${query.toString()}`;
}

/** The email's default landing tab (event-focused). */
export const SHARE_DEFAULT_TAB: ShareTab = "hotspots";
