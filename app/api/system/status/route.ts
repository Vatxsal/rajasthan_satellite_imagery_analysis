import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authorize, forbiddenRoleResponse } from "@/lib/auth/guard";
import { PERMISSIONS, limitsFor, type QuotaKind, type Role } from "@/lib/auth/permissions";
import { quotaUsage, readGlobalCounters } from "@/lib/auth/quota";
import { getTokenHealth } from "@/lib/cdse/auth";
import { districtsFc, tehsilsFc } from "@/lib/data/boundaries";
import { assertEmailReady, emailDeliveryEnabled } from "@/lib/email";
import { dataSource, getServerEnv } from "@/lib/env";
import { errorResponse, rateLimitGuard } from "@/lib/server/api";

export const runtime = "nodejs";
export const maxDuration = 30;

const QUOTA_KINDS: QuotaKind[] = ["search", "compare", "aiSummary"];

function buildVersion(): string {
  try {
    const raw = readFileSync(join(process.cwd(), "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function cdseHealth(): { status: string; message?: string; tokenValidForSeconds?: number } {
  if (dataSource === "mock") {
    return { status: "mock", message: "Demo data source — live Copernicus calls are off." };
  }
  try {
    const env = getServerEnv();
    if (!env.CDSE_CLIENT_ID || !env.CDSE_CLIENT_SECRET) {
      return {
        status: "unconfigured",
        message: "CDSE_CLIENT_ID and CDSE_CLIENT_SECRET are not set.",
      };
    }
  } catch (error) {
    return { status: "unconfigured", message: error instanceof Error ? error.message : String(error) };
  }
  return { status: "checking" };
}

async function cdseTokenHealth(): Promise<{ status: string; message?: string; tokenValidForSeconds?: number }> {
  const preliminary = cdseHealth();
  if (preliminary.status !== "checking") return preliminary;
  try {
    const { expiresIn } = await getTokenHealth();
    return { status: "ok", tokenValidForSeconds: expiresIn };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function geminiHealth(): { status: string; message?: string; model?: string } {
  try {
    const env = getServerEnv();
    if (!env.GEMINI_API_KEY) {
      return { status: "unconfigured", message: "GEMINI_API_KEY is not set." };
    }
    return { status: "ok", model: env.GEMINI_MODEL || undefined };
  } catch (error) {
    return { status: "unconfigured", message: error instanceof Error ? error.message : String(error) };
  }
}

function emailHealth(): { status: string; message?: string; provider?: string } {
  try {
    const env = getServerEnv();
    if (!emailDeliveryEnabled(env)) {
      return { status: "disabled", message: "Email delivery is switched off on this deployment." };
    }
    assertEmailReady(env);
    return { status: "ok", provider: env.EMAIL_PROVIDER };
  } catch (error) {
    return { status: "unconfigured", message: error instanceof Error ? error.message : String(error) };
  }
}

function callerUsage(role: Role, ip: string): Record<QuotaKind, { used: number; limit: number; remaining: number }> {
  const limits = limitsFor(role);
  const subject = { sub: `status:${role}`, ip };
  const limitOf = (kind: QuotaKind): number =>
    kind === "search" ? limits.searchesPerDay : kind === "compare" ? limits.comparePerDay : limits.aiSummariesPerDay;
  return Object.fromEntries(
    QUOTA_KINDS.map((kind) => [kind, quotaUsage(kind, subject, limitOf(kind))]),
  ) as Record<QuotaKind, { used: number; limit: number; remaining: number }>;
}

/**
 * GET /api/system/status — SSO-only operations readout for the rail panel:
 * CDSE / Gemini / email health (reason codes, never secrets), today's
 * deployment counters vs the caller's role quotas, data-source mode, build
 * version and boundary counts. 401 without a session, 403 FORBIDDEN_ROLE for
 * guests (system.status is SSO-only).
 */
export async function GET(request: Request): Promise<Response> {
  const guard = rateLimitGuard(request, "api");
  if (guard) return guard;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;
  if (!PERMISSIONS[auth.role].capabilities["system.status"]) {
    return forbiddenRoleResponse("system.status");
  }

  try {
    const env = getServerEnv();
    const [cdse, today] = await Promise.all([cdseTokenHealth(), Promise.resolve(readGlobalCounters())]);

    return NextResponse.json(
      {
        dataSource,
        buildVersion: buildVersion(),
        districts: districtsFc.features.length,
        tehsils: tehsilsFc.features.length,
        health: {
          cdse,
          gemini: geminiHealth(),
          email: emailHealth(),
        },
        today,
        roleUsage: callerUsage(auth.role, auth.ip),
        limits: PERMISSIONS[auth.role].limits,
        emailProvider: env.EMAIL_PROVIDER,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
