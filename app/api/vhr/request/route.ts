import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authorize } from "@/lib/auth/guard";
import { getServerEnv } from "@/lib/env";
import {
  getEmailProvider,
  siteUrl,
  emailHash,
  EmailSendError,
} from "@/lib/email";
import {
  renderVhrRequestEmail,
  type VhrRequestEmailData,
} from "@/lib/email/template/VhrRequestEmail";
import { getClientIp } from "@/lib/rateLimit";
import {
  accessDailyGuard,
  accessMarkSent,
  accessWasRecentlySent,
} from "@/lib/server/accessRequest";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";

export const runtime = "nodejs";

const BODY_LIMIT = 64_000;
/** Vertex cap so a pasted/simplified boundary can't balloon the email. */
const MAX_VERTICES = 50_000;

type AoiGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

/** Trim + collapse every whitespace run (including CR/LF) to one space. */
function normalizeField(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const requestSchema = z.object({
  aoi: z.unknown(),
  areaName: z
    .string()
    .max(120, "Area name is too long.")
    .transform(normalizeField)
    .refine((value) => value.length > 0, "Area name is required.")
    .refine((value) => !hasControlChars(value), "Area name contains invalid characters."),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "startDate must be YYYY-MM-DD")
    .nullish(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "endDate must be YYYY-MM-DD")
    .nullish(),
  /** Honeypot — hidden in the UI, bots fill it and get a fake success. */
  website: z.string().max(256).optional(),
});

function isPosition(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number" &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/** Structural walk: finite positions, closed rings, bounded vertex count. */
function validateAoi(raw: unknown): { geometry: AoiGeometry; vertices: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const geometry = raw as { type?: unknown; coordinates?: unknown };
  const countRing = (ring: unknown): number | null => {
    if (!Array.isArray(ring) || ring.length < 4) return null;
    let total = 0;
    for (const position of ring) {
      if (!isPosition(position)) return null;
      total += 1;
    }
    const first = ring[0] as [number, number];
    const last = ring[total - 1] as [number, number];
    if (first[0] !== last[0] || first[1] !== last[1]) return null;
    return total;
  };

  if (geometry.type === "Polygon") {
    const rings = geometry.coordinates;
    if (!Array.isArray(rings) || rings.length === 0) return null;
    let total = 0;
    for (const ring of rings) {
      const count = countRing(ring);
      if (count === null) return null;
      total += count;
    }
    if (total > MAX_VERTICES) return null;
    return { geometry: geometry as AoiGeometry, vertices: total };
  }

  if (geometry.type === "MultiPolygon") {
    const polygons = geometry.coordinates;
    if (!Array.isArray(polygons) || polygons.length === 0) return null;
    let total = 0;
    for (const rings of polygons) {
      if (!Array.isArray(rings) || rings.length === 0) return null;
      for (const ring of rings) {
        const count = countRing(ring);
        if (count === null) return null;
        total += count;
      }
    }
    if (total > MAX_VERTICES) return null;
    return { geometry: geometry as AoiGeometry, vertices: total };
  }
  return null;
}

function geometryBBox(geometry: AoiGeometry): [number, number, number, number] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const visit = (coordinates: unknown): void => {
    if (isPosition(coordinates)) {
      west = Math.min(west, coordinates[0]);
      south = Math.min(south, coordinates[1]);
      east = Math.max(east, coordinates[0]);
      north = Math.max(north, coordinates[1]);
      return;
    }
    if (Array.isArray(coordinates)) for (const entry of coordinates) visit(entry);
  };
  visit(geometry.coordinates);
  return [west, south, east, north];
}

function requestId(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `VR-${day}-${randomBytes(3).toString("hex")}`;
}

/** Idempotency key: normalised fields + AOI bbox, hashed. */
function vhrContentKey(input: {
  areaName: string;
  startDate: string | null;
  endDate: string | null;
  bbox: [number, number, number, number];
}): string {
  const payload = [
    input.areaName,
    input.startDate ?? "",
    input.endDate ?? "",
    input.bbox.map((value) => value.toFixed(6)).join(","),
  ].join("\n");
  return createHash("sha256").update(`rse-vhr-request-v1:${payload}`).digest("hex").slice(0, 32);
}

/**
 * POST /api/vhr/request — "request high-resolution imagery for this area".
 *
 * Flow: same-origin → per-minute api bucket → session (ambient guest when
 * the auth gate is off, same as every other route) → size-capped zod parse →
 * AOI structural validation (closed rings, finite positions, vertex cap) →
 * honeypot fake 202 → availability (EMAIL_FIXED_RECIPIENT + daily cap, else
 * 503) → 10-minute duplicate suppression (no quota) → shared per-IP /
 * per-requester / deployment daily caps (lib/server/accessRequest — the same
 * mailbox budget as the SSO access request) → render + send with the AOI as
 * an `aoi.geojson` attachment. Nothing is stored.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const apiGuard = rateLimitGuard(request, "api");
  if (apiGuard) return apiGuard;

  const started = Date.now();
  try {
    const auth = await authorize(request);
    if (auth instanceof NextResponse) return auth;

    const env = getServerEnv();
    const body = await readJsonBody(
      request,
      (raw) => requestSchema.parse(raw),
      BODY_LIMIT,
    );

    if (body.website && body.website.trim().length > 0) {
      console.warn("[vhr:request] status=honeypot");
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    const aoi = validateAoi(body.aoi);
    if (!aoi) {
      throw apiError(
        400,
        "INVALID_AOI",
        "AOI must be a Polygon or MultiPolygon with closed rings and finite coordinates.",
      );
    }
    if (body.startDate && body.endDate && body.startDate > body.endDate) {
      throw apiError(400, "INVALID_DATES", "startDate must not be after endDate.");
    }

    const fixedRecipient = env.EMAIL_FIXED_RECIPIENT?.trim() || null;
    if (!fixedRecipient || env.ACCESS_REQUEST_DAILY_CAP <= 0) {
      throw apiError(
        503,
        "VHR_UNAVAILABLE",
        "Imagery requests are unavailable right now. Please try again later.",
      );
    }

    const bbox = geometryBBox(aoi.geometry);
    if (!bbox.every(Number.isFinite)) {
      throw apiError(400, "INVALID_AOI", "AOI coordinates are out of range.");
    }

    const contentKey = vhrContentKey({
      areaName: body.areaName,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      bbox,
    });
    if (accessWasRecentlySent(contentKey)) {
      console.log(
        `[vhr:request] status=duplicate key=${contentKey.slice(0, 12)} durationMs=${Date.now() - started}`,
      );
      return NextResponse.json({ ok: true, duplicate: true }, { status: 202 });
    }

    // Shares the access-request mailbox budget: one admin inbox, one set of
    // abuse counters (per-IP / per-requester / deployment-wide per UTC day).
    const requesterHash = emailHash(`vhr:${auth.sub}`);
    const ip = getClientIp(request);
    const daily = accessDailyGuard({ ip, addressHash: requesterHash });
    if (!daily.ok) {
      return NextResponse.json(
        {
          code: "VHR_RATE_LIMITED",
          message: `You have reached today's limit. Try again after midnight IST (${daily.retryAfterSeconds}s).`,
        },
        { status: 429, headers: { "Retry-After": String(daily.retryAfterSeconds) } },
      );
    }

    const origin = siteUrl(env);
    const data: VhrRequestEmailData = {
      areaName: body.areaName,
      startDate: body.startDate ?? null,
      endDate: body.endDate ?? null,
      bbox,
      geometrySummary: `${aoi.geometry.type} · ${aoi.vertices} vertices`,
      requestedAt: new Date().toISOString(),
      requestId: requestId(),
      requester: auth.sub,
      siteUrl: origin || "https://rajasthan-satellite-explorer.vercel.app",
    };

    const rendered = await renderVhrRequestEmail(data);
    const aoiFeature: GeoJSON.Feature = {
      type: "Feature",
      properties: {
        areaName: data.areaName,
        startDate: data.startDate,
        endDate: data.endDate,
        requestId: data.requestId,
      },
      geometry: aoi.geometry,
    };

    const provider = getEmailProvider(env);
    try {
      const result = await provider.send({
        to: fixedRecipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments: [
          {
            filename: "aoi.geojson",
            content: Buffer.from(JSON.stringify(aoiFeature, null, 2), "utf8"),
            contentType: "application/geo+json",
          },
        ],
      });
      console.log(
        `[vhr:request] status=sent provider=${result.provider} ` +
          `id=${data.requestId} requester=${requesterHash.slice(0, 12)} ip=${ip} ` +
          `htmlBytes=${Buffer.byteLength(rendered.html, "utf8")} ` +
          `durationMs=${Date.now() - started}`,
      );
      accessMarkSent(contentKey);
      return NextResponse.json({ ok: true }, { status: 202 });
    } catch (error) {
      if (error instanceof EmailSendError) throw error;
      console.warn(
        `[vhr:request] status=send-failed id=${data.requestId} ${error instanceof Error ? error.message : String(error)}`,
      );
      throw apiError(502, "VHR_SEND_FAILED", "Your request could not be sent. Try again shortly.");
    }
  } catch (error) {
    const err = error as { code?: string };
    console.warn(
      `[vhr:request] status=failed code=${err.code ?? "UNKNOWN"} durationMs=${Date.now() - started}`,
    );
    return errorResponse(error);
  }
}
