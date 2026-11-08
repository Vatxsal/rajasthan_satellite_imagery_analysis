import { z } from "zod";
import { isValidEmail } from "./email/addressCore";
import { dataSource } from "./dataSource";
import { sharedInstance } from "./singleton";

export { dataSource } from "./dataSource";

const optionalString = z.string().trim().optional();

/**
 * Env-var boolean: accepts true/false/1/0/yes/no/on/off case-insensitively.
 * z.coerce.boolean would treat the string "false" as true, so parse explicitly.
 */
const boolEnv = () =>
  z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
    return value; // unknown token → zod type error below
  }, z.boolean());

const baseSchema = z.object({
  CDSE_TOKEN_URL: z
    .string()
    .url()
    .default(
      "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token",
    ),
  CDSE_SH_BASE_URL: z
    .string()
    .url()
    .default("https://sh.dataspace.copernicus.eu"),
  CDSE_WMTS_INSTANCE_ID: optionalString,
  MAX_AOI_KM2: z.coerce.number().positive().default(70_000),
  IMAGERY_CACHE_TTL_SECONDS: z.coerce.number().positive().default(86_400),
  RATE_LIMIT_PER_MIN: z.coerce.number().positive().default(30),
  /** Higher budget for XYZ tile fetches (MapLibre requests many per pan/zoom). */
  RATE_LIMIT_TILES_PER_MIN: z.coerce.number().positive().default(240),
  /** Optional on-disk tile cache directory (empty string disables disk cache). */
  TILE_CACHE_DIR: z.string().trim().optional(),
  /** Daily cap on Copernicus Process API renders (UTC day, per instance); 0 disables. */
  DAILY_RENDER_BUDGET: z.coerce.number().int().min(0).default(3000),
  /** Long-side cap (px) of the change-detection analysis grid. */
  COMPARE_MAX_PX: z.coerce.number().int().min(256).max(4096).default(1500),
  /**
   * PU cap per analysis (2 Process renders, CDSE formula — audit §5).
   * Estimates run through prepareCompare before any fetch; 0 disables.
   */
  PER_ANALYSIS_PU_LIMIT: z.coerce.number().int().min(0).default(700),
  /** Change engine: v1 = single-date inputs (stable), v2 = composite inputs. */
  CHANGE_ENGINE: z.enum(["v1", "v2"]).default("v1"),
  /** Change-rule mode: legacy = shipped classifiers; fused = Phase 3 rules
   *  (SAR + WorldCover + terrain evidence). Fused runs the v2 engine. */
  CHANGE_RULES: z.enum(["legacy", "fused"]).default("fused"),
  /** Sentinel-1 SAR evidence for the fused rules (each side = 1 extra render). */
  S1_ENABLED: boolEnv().default(true),
  /** ±days around each date for the S1 temporal median (one orbit per side). */
  S1_WINDOW_DAYS: z.coerce.number().int().min(0).max(15).default(6),
  /** ESA WorldCover land-cover prior (2021 v200 COG windows; graceful off). */
  WORLDCOVER_ENABLED: boolEnv().default(true),
  /** Per-IP budget for /api/compare/analyze (each run costs 2 Process renders). */
  COMPARE_RATE_LIMIT_PER_MIN: z.coerce.number().positive().default(6),
  /** Per-IP budget for /api/compare/summary (Gemini). */
  AI_SUMMARY_RATE_LIMIT_PER_MIN: z.coerce.number().positive().default(5),
  /** Optional Gemini key for the AI summary card; empty disables it (AI_DISABLED). */
  GEMINI_API_KEY: optionalString,
  /** Gemini model id for the summary (free-tier Flash class). Must appear in
   *  the Gemini ListModels response — verify via GET /api/health/gemini. */
  GEMINI_MODEL: z.string().trim().min(1).default("gemini-2.5-flash"),

  // ── Email report (/api/compare/email) ──────────────────────────────────
  /** Delivery backend. console (default) writes .email-preview/ files and never sends. */
  EMAIL_PROVIDER: z.enum(["console", "smtp", "resend"]).default("console"),
  /** Sender: `Display Name <address@example.org>` (bare address also accepted). */
  EMAIL_FROM: optionalString,
  /** SMTP (EMAIL_PROVIDER=smtp): host/port/auth. STARTTLS on 587, implicit TLS on 465. */
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** "true" = implicit TLS (SMTPS, usually 465); "false" = STARTTLS. */
  SMTP_SECURE: boolEnv().default(false),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  /** Resend (EMAIL_PROVIDER=resend): API key from https://resend.com/api-keys. */
  RESEND_API_KEY: optionalString,
  /** Abuse limits — in-memory per instance (reset on cold start; see README). */
  EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY: z.coerce.number().int().min(1).default(3),
  EMAIL_RATE_LIMIT_PER_IP_PER_DAY: z.coerce.number().int().min(1).default(10),
  /** Instance-wide sends per UTC day; 0 disables the cap. */
  EMAIL_DAILY_CAP: z.coerce.number().int().min(0).default(80),
  /** Attach the full events.csv when true. */
  EMAIL_ATTACH_CSV: boolEnv().default(true),
  /**
   * Fixed-recipient mode: when set, every report goes to this ONE server-side
   * address and the API rejects any request that carries an `email` field.
   * Blank/unset = typed-address ("open") mode.
   */
  EMAIL_FIXED_RECIPIENT: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z
      .string()
      .trim()
      .refine((value) => isValidEmail(value), {
        message: "must be a single valid email address",
      })
      .optional(),
  ),
  /**
   * Open (typed-address) mode escape hatch. In production the typed mode is
   * refused with EMAIL_DISABLED unless this is exactly "true" — so a
   * production deployment can never accidentally become an open relay.
   */
  EMAIL_ALLOW_ANY_RECIPIENT: boolEnv().default(false),
  /** Dev-only target for `npm run email:test` — never read by the API route. */
  EMAIL_TEST_RECIPIENT: optionalString,
  /** Optional Cloudflare Turnstile anti-abuse (blank = disabled). */
  TURNSTILE_SITE_KEY: optionalString,
  TURNSTILE_SECRET_KEY: optionalString,
  /** Canonical site origin for email deep links; required to actually send. */
  NEXT_PUBLIC_SITE_URL: z.string().trim().url().optional(),
});

/** Strict shape used when NEXT_PUBLIC_DATA_SOURCE=cdse — credentials are mandatory. */
const cdseSchema = baseSchema.extend({
  CDSE_CLIENT_ID: z.string().trim().min(1, "CDSE_CLIENT_ID is required"),
  CDSE_CLIENT_SECRET: z.string().trim().min(1, "CDSE_CLIENT_SECRET is required"),
});

/** Lenient shape for mock mode — CDSE keys may be blank. */
const mockSchema = baseSchema.extend({
  CDSE_CLIENT_ID: optionalString,
  CDSE_CLIENT_SECRET: optionalString,
});

export interface ServerEnv {
  CDSE_CLIENT_ID?: string;
  CDSE_CLIENT_SECRET?: string;
  CDSE_TOKEN_URL: string;
  CDSE_SH_BASE_URL: string;
  CDSE_WMTS_INSTANCE_ID?: string;
  MAX_AOI_KM2: number;
  IMAGERY_CACHE_TTL_SECONDS: number;
  RATE_LIMIT_PER_MIN: number;
  RATE_LIMIT_TILES_PER_MIN: number;
  TILE_CACHE_DIR?: string;
  DAILY_RENDER_BUDGET: number;
  COMPARE_MAX_PX: number;
  PER_ANALYSIS_PU_LIMIT: number;
  CHANGE_ENGINE: "v1" | "v2";
  CHANGE_RULES: "legacy" | "fused";
  S1_ENABLED: boolean;
  S1_WINDOW_DAYS: number;
  WORLDCOVER_ENABLED: boolean;
  COMPARE_RATE_LIMIT_PER_MIN: number;
  AI_SUMMARY_RATE_LIMIT_PER_MIN: number;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
  EMAIL_PROVIDER: "console" | "smtp" | "resend";
  EMAIL_FROM?: string;
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_SECURE: boolean;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  RESEND_API_KEY?: string;
  EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY: number;
  EMAIL_RATE_LIMIT_PER_IP_PER_DAY: number;
  EMAIL_DAILY_CAP: number;
  EMAIL_ATTACH_CSV: boolean;
  EMAIL_FIXED_RECIPIENT?: string;
  EMAIL_ALLOW_ANY_RECIPIENT: boolean;
  EMAIL_TEST_RECIPIENT?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  NEXT_PUBLIC_SITE_URL?: string;
}

/**
 * Provider-specific email requirements, applied after the static parse:
 * everything stays optional while EMAIL_PROVIDER=console (the default) and
 * only becomes mandatory once real delivery is selected — so a half-filled
 * .env.local still boots the app for local development.
 * Throws the same "Invalid environment configuration" contract the CDSE
 * checks use (errorResponse() maps it to CDSE_CONFIG without secrets).
 */
function validateEmailSettings(env: ServerEnv): void {
  const problems: string[] = [];
  const bareFrom = (env.EMAIL_FROM ?? "").match(/<([^<>]+)>/)?.[1] ?? env.EMAIL_FROM ?? "";
  if (env.EMAIL_FROM && !/^[^\s@,;:<>"[\]\\]+@[^\s@,;:<>"[\]\\]+\.[^\s@,;:<>"[\]\\]+$/.test(bareFrom.trim())) {
    problems.push("EMAIL_FROM: expected `Display Name <address@example.org>` or a bare address.");
  }
  if (env.EMAIL_PROVIDER === "smtp") {
    if (!env.SMTP_HOST) problems.push("SMTP_HOST is required when EMAIL_PROVIDER=smtp.");
    if (!env.EMAIL_FROM) problems.push("EMAIL_FROM is required when EMAIL_PROVIDER=smtp.");
  }
  if (env.EMAIL_PROVIDER === "resend") {
    if (!env.RESEND_API_KEY) problems.push("RESEND_API_KEY is required when EMAIL_PROVIDER=resend.");
    if (!env.EMAIL_FROM) problems.push("EMAIL_FROM is required when EMAIL_PROVIDER=resend.");
  }
  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration (EMAIL_PROVIDER=${env.EMAIL_PROVIDER}):\n${problems
        .map((line) => `- ${line}`)
        .join("\n")}`,
    );
  }
}

/**
 * Process-wide (globalThis) so every route graph shares one validated env —
 * plain module state would fork per route under `next dev` HMR / Vercel
 * function bundling (lib/singleton.ts).
 */
const envHolder = sharedInstance("rse.serverEnv", () => ({ cached: null as ServerEnv | null }));

/**
 * Server-only env loader. Validates with zod and, when NEXT_PUBLIC_DATA_SOURCE=cdse,
 * throws a single clear error listing every missing/invalid variable.
 * Never import the result into client code — CDSE_* keys have no NEXT_PUBLIC_ prefix
 * and are therefore never inlined into the browser bundle.
 */
export function getServerEnv(): ServerEnv {
  if (envHolder.cached) return envHolder.cached;

  const schema = dataSource === "cdse" ? cdseSchema : mockSchema;
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `- ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration (NEXT_PUBLIC_DATA_SOURCE=${dataSource}):\n${issues}`,
    );
  }

  validateEmailSettings(parsed.data);
  envHolder.cached = parsed.data;
  return envHolder.cached;
}

/**
 * CHANGE_RULES selects the classifier; the fused rules (Phase 3) run on the
 * v2 composite machinery, so `fused` resolves the engine to "v2" regardless
 * of CHANGE_ENGINE. `legacy` honours CHANGE_ENGINE as before.
 */
export function resolveChangeRules(env: Pick<ServerEnv, "CHANGE_RULES" | "CHANGE_ENGINE">): {
  rules: "legacy" | "fused";
  engine: "v1" | "v2";
} {
  const rules = env.CHANGE_RULES;
  return { rules, engine: rules === "fused" ? "v2" : env.CHANGE_ENGINE };
}
