import { z } from "zod";
import { dataSource } from "./dataSource";

export { dataSource } from "./dataSource";

const optionalString = z.string().trim().optional();

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
  /** Per-IP budget for /api/compare/analyze (each run costs 2 Process renders). */
  COMPARE_RATE_LIMIT_PER_MIN: z.coerce.number().positive().default(6),
  /** Per-IP budget for /api/compare/summary (Gemini). */
  AI_SUMMARY_RATE_LIMIT_PER_MIN: z.coerce.number().positive().default(5),
  /** Optional Gemini key for the AI summary card; empty disables it (AI_DISABLED). */
  GEMINI_API_KEY: optionalString,
  /** Gemini model id for the summary (free-tier Flash by default). */
  GEMINI_MODEL: z.string().trim().min(1).default("gemini-3.8-flash"),
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
  COMPARE_RATE_LIMIT_PER_MIN: number;
  AI_SUMMARY_RATE_LIMIT_PER_MIN: number;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
}

let cachedEnv: ServerEnv | null = null;

/**
 * Server-only env loader. Validates with zod and, when NEXT_PUBLIC_DATA_SOURCE=cdse,
 * throws a single clear error listing every missing/invalid variable.
 * Never import the result into client code — CDSE_* keys have no NEXT_PUBLIC_ prefix
 * and are therefore never inlined into the browser bundle.
 */
export function getServerEnv(): ServerEnv {
  if (cachedEnv) return cachedEnv;

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

  cachedEnv = parsed.data;
  return cachedEnv;
}
