/**
 * Roles & permissions — the SINGLE SOURCE OF TRUTH for what each session
 * role may do. Every capability flag, numeric limit and daily quota below is
 * read from here (routes via lib/auth/guard.ts, the session endpoint, the
 * README table generator) — nothing else hard-codes a role check.
 *
 * Only two roles exist today:
 *   guest — anonymous explorer: browse with tight limits, no exports/AI/email.
 *   sso   — every SSO user has FULL access, including admin-grade tools
 *           (email report, system status). There is deliberately NO separate
 *           admin/member role and NO role field on SSO_USERS: the role comes
 *           from the session claim only (see session.ts).
 *
 * Adding a third role later:
 *   1. extend SessionRole in ./session.ts (verifySession shape-check + test),
 *   2. add one entry to PERMISSIONS below.
 * Call sites never enumerate roles — they ask can()/requireCapability(), so
 * no route, component or doc table needs touching.
 *
 * This module is pure data + pure functions (no env, no I/O, Edge-safe) so
 * middleware, route handlers, client code and the docs script can all import
 * it. Daily counters live in ./quota.ts; the request guard lives in
 * ./guard.ts — the policy itself never changes at runtime.
 */
import type { AreaLevel } from "../data/types";
import type { Sensitivity } from "../analysis/config";

export type { AreaLevel, Sensitivity };

/** The session roles. Mirrors SessionRole in ./session.ts (kept type-only
 *  here so this file has no jose dependency). */
export type Role = "guest" | "sso";

/**
 * Capability ids — dotted, stable, UI- and API-facing. A capability is a
 * boolean permission; numeric ceilings live in RoleLimits instead.
 */
export const CAPABILITIES = [
  /** Scene/catalogue search (consumes the daily search quota). */
  "scenes.search",
  /** View a completed comparison's overlay/events/stats. */
  "compare.view",
  /** Run a new comparison (consumes the daily compare quota). */
  "compare.analyses",
  /** Compare at district level (tehsil/ILR are open to every role). */
  "compare.district",
  /** Change detection sensitivity away from the default. */
  "compare.adjust-sensitivity",
  /** Minimum patch size away from the default. */
  "compare.adjust-min-patch",
  /** PNG imagery renders, up to the role's pixel cap. */
  "downloads.png",
  /** GeoTIFF renders (visual + analysis). */
  "downloads.geotiff",
  /** Deep links out to Copernicus Browser / Data Space. */
  "downloads.copernicus",
  /** Change-map exports (PNG + GeoTIFF) from the compare drawer. */
  "exports.change-map",
  /** Statistics CSV export. */
  "exports.csv",
  /** Events GeoJSON export. */
  "exports.geojson",
  /** Scene imagery GeoTIFF export. */
  "exports.imagery",
  /** Gemini-backed AI summary (consumes the daily AI quota). */
  "ai.summary",
  /** Email a comparison report. */
  "email.report",
  /** Fields / cropping-pattern analysis. */
  "fields.pattern",
  /** Read-only system status panel. */
  "system.status",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Human labels for the README table and UI copy (never used for logic). */
export const CAPABILITY_LABELS: Record<Capability, string> = {
  "scenes.search": "Scene search",
  "compare.view": "View comparisons",
  "compare.analyses": "Run comparisons",
  "compare.district": "District-level compare",
  "compare.adjust-sensitivity": "Adjust sensitivity",
  "compare.adjust-min-patch": "Adjust minimum patch",
  "downloads.png": "PNG preview download",
  "downloads.geotiff": "GeoTIFF download",
  "downloads.copernicus": "Copernicus Browser links",
  "exports.change-map": "Change-map export (PNG/GeoTIFF)",
  "exports.csv": "CSV export",
  "exports.geojson": "GeoJSON export",
  "exports.imagery": "Imagery GeoTIFF export",
  "ai.summary": "AI summary",
  "email.report": "Email report",
  "fields.pattern": "Fields / cropping pattern",
  "system.status": "System status panel",
};

/** Numeric ceilings per role. `null` = unlimited (full archive window). */
export interface RoleLimits {
  /** Max days between fromDate and toDate in a scene search. */
  searchWindowDays: number | null;
  /** Highest native tile zoom served; tiles above this are refused. */
  tileZoomMax: number;
  /** Scene searches per UTC day (per session AND per IP). */
  searchesPerDay: number;
  /** Compare analyses per UTC day (per session AND per IP). */
  comparePerDay: number;
  /** AI summaries per UTC day (per session AND per IP). */
  aiSummariesPerDay: number;
  /** Max edge length in px for /api/imagery renders. */
  downloadMaxPx: number;
}

export interface RolePolicy {
  /** Badge/docs label. */
  readonly label: string;
  readonly capabilities: Readonly<Record<Capability, boolean>>;
  readonly limits: RoleLimits;
}

/**
 * The policy table. Defaults are a starting point and are expected to be
 * tuned — change values here only; call sites pick them up automatically.
 *
 * Quota note: guest compares are 3/day, SSO 50/day; guest has no AI summary,
 * email, exports, fields or system status at all. Guest search is capped at a
 * 90-day window, z12 tiles and 1024 px PNG previews.
 */
export const PERMISSIONS: Readonly<Record<Role, RolePolicy>> = {
  guest: {
    label: "Guest",
    capabilities: {
      "scenes.search": true,
      "compare.view": true,
      "compare.analyses": true,
      "compare.district": false,
      "compare.adjust-sensitivity": false,
      "compare.adjust-min-patch": false,
      "downloads.png": true,
      "downloads.geotiff": false,
      "downloads.copernicus": true,
      "exports.change-map": false,
      "exports.csv": false,
      "exports.geojson": false,
      "exports.imagery": false,
      "ai.summary": false,
      "email.report": false,
      // Not part of the guest default set — treat as SSO-only until decided
      // otherwise (flip to true here if guests should see cropping patterns).
      "fields.pattern": false,
      "system.status": false,
    },
    limits: {
      searchWindowDays: 90,
      tileZoomMax: 12,
      searchesPerDay: 30,
      comparePerDay: 3,
      aiSummariesPerDay: 0,
      downloadMaxPx: 1024,
    },
  },
  sso: {
    label: "SSO",
    capabilities: {
      // Full access for every SSO user — no narrower role exists.
      "scenes.search": true,
      "compare.view": true,
      "compare.analyses": true,
      "compare.district": true,
      "compare.adjust-sensitivity": true,
      "compare.adjust-min-patch": true,
      "downloads.png": true,
      "downloads.geotiff": true,
      "downloads.copernicus": true,
      "exports.change-map": true,
      "exports.csv": true,
      "exports.geojson": true,
      "exports.imagery": true,
      "ai.summary": true,
      "email.report": true,
      "fields.pattern": true,
      "system.status": true,
    },
    limits: {
      searchWindowDays: null, // full archive
      tileZoomMax: 14,
      // Not in the brief for SSO — generous placeholder, adjust freely.
      searchesPerDay: 300,
      comparePerDay: 50,
      aiSummariesPerDay: 30,
      downloadMaxPx: 2500,
    },
  },
};

/** Daily quota buckets. Which capability consumes which bucket: */
export type QuotaKind = "search" | "compare" | "aiSummary";

/**
 * Capability → daily quota. Only these capabilities are metered; calling
 * requireCapability() for them consumes one unit (both per-session and
 * per-IP counters — see quota.ts).
 */
export const QUOTA_BY_CAPABILITY: Readonly<Partial<Record<Capability, QuotaKind>>> = {
  "scenes.search": "search",
  "compare.analyses": "compare",
  "ai.summary": "aiSummary",
};

/** RoleLimits keys that hold a daily counter (excludes nullable limits). */
export type CounterLimitKey = {
  [K in keyof RoleLimits]: RoleLimits[K] extends number ? K : never;
}[keyof RoleLimits];

/** RoleLimits key for a quota kind (single mapping used by guard + docs). */
export const QUOTA_LIMIT_KEY: Readonly<Record<QuotaKind, CounterLimitKey>> = {
  search: "searchesPerDay",
  compare: "comparePerDay",
  aiSummary: "aiSummariesPerDay",
};

/** The policy for a role (throws only on a programming error — roles are a closed union). */
export function policyFor(role: Role): RolePolicy {
  const policy = PERMISSIONS[role];
  if (!policy) throw new Error(`Unknown role: ${String(role)}`);
  return policy;
}

/** True when the role holds the capability. */
export function can(role: Role, capability: Capability): boolean {
  return policyFor(role).capabilities[capability] === true;
}

/** The numeric limits for a role. */
export function limitsFor(role: Role): RoleLimits {
  return policyFor(role).limits;
}

/** Labels for a capability across all roles (docs/debug). */
export function rolesWithCapability(capability: Capability): Role[] {
  return (Object.keys(PERMISSIONS) as Role[]).filter((role) => can(role, capability));
}

/** District level needs compare.district; tehsil and ILR are open to all. */
export function isLevelAllowed(role: Role, level: AreaLevel): boolean {
  if (level === "district") return can(role, "compare.district");
  return true;
}

/** Days between two YYYY-MM-DD dates (UTC, inclusive span = difference). */
export function spanDays(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`);
  const to = Date.parse(`${toDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return Number.POSITIVE_INFINITY;
  return Math.floor((to - from) / 86_400_000);
}

/**
 * True when the requested search window is wider than the role allows
 * (null window = unlimited). Routes reject with 400 rather than silently
 * re-dating the query, so the UI constrains its date pickers instead.
 */
export function exceedsSearchWindow(role: Role, fromDate: string, toDate: string): boolean {
  const limit = limitsFor(role).searchWindowDays;
  if (limit === null) return false;
  return spanDays(fromDate, toDate) > limit;
}

/** The default tuning values — guests (and the schema defaults) sit here. */
export const DEFAULT_SENSITIVITY: Sensitivity = "medium";
export const DEFAULT_MIN_PATCH_HA = 0.2;

/**
 * Forces sensitivity/minPatchHa back to the defaults for roles that may not
 * adjust them (clamping, not rejecting: tuning is a convenience, not a lock).
 */
export function clampCompareTuning<T extends { sensitivity: Sensitivity; minPatchHa: number }>(
  role: Role,
  params: T,
): T {
  const policy = policyFor(role);
  return {
    ...params,
    sensitivity: policy.capabilities["compare.adjust-sensitivity"]
      ? params.sensitivity
      : DEFAULT_SENSITIVITY,
    minPatchHa: policy.capabilities["compare.adjust-min-patch"]
      ? params.minPatchHa
      : DEFAULT_MIN_PATCH_HA,
  };
}
