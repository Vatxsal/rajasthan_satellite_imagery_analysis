import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/lib/env";
import {
  emailHash,
  getEmailProvider,
  isValidEmail,
  siteUrl,
  EmailSendError,
} from "@/lib/email";
import {
  renderAccessRequestEmail,
  type AccessRequestEmailData,
} from "@/lib/email/template/AccessRequestEmail";
import { getClientIp } from "@/lib/rateLimit";
import {
  accessContentKey,
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
import { turnstileEnabled, verifyTurnstile } from "@/lib/server/turnstile";

export const runtime = "nodejs";

const ACCESS_BODY_LIMIT = 6_000;

/** Trim + collapse every whitespace run (including CR/LF) to one space. */
function normalizeField(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * After normalization only genuine control characters can remain (whitespace
 * is already collapsed to plain spaces). A charCode walk avoids regex-escape
 * hazards with raw control bytes in source.
 */
function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function cleanField(max: number, label: string) {
  return z
    .string()
    .max(max, `${label} is too long.`)
    .transform(normalizeField)
    .refine((value) => value.length > 0, `${label} is required.`)
    .refine((value) => !hasControlChars(value), `${label} contains invalid characters.`);
}

const accessRequestSchema = z.object({
  name: cleanField(80, "Full name"),
  company: cleanField(120, "Company / organisation"),
  email: z
    .string()
    .max(254, "Email is too long.")
    .transform(normalizeField)
    .refine((value) => value.length > 0, "Email is required.")
    .refine((value) => !hasControlChars(value), "Email contains invalid characters.")
    .refine((value) => isValidEmail(value), "Enter a valid email address."),
  reason: cleanField(1_000, "Reason for access"),
  turnstileToken: z.string().max(4_096).optional(),
  /** Honeypot — hidden in the UI, bots fill it and get a fake success. */
  website: z.string().max(256).optional(),
});

function requestId(): string {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `AR-${day}-${randomBytes(3).toString("hex")}`;
}

/**
 * POST /api/access-request — public SSO access request.
 *
 * Flow: same-origin → per-minute api bucket → size-capped zod validation
 * (trim, whitespace collapse, control-char rejection) → honeypot fake 202 →
 * availability (EMAIL_FIXED_RECIPIENT set and daily cap > 0, else 503 with
 * a friendly message) → optional Turnstile (fail closed) → 10-minute
 * duplicate-content suppression (no quota) → independent daily quotas
 * (per-IP / per-requester-address / deployment cap) → render + send via the
 * existing provider stack with Reply-To = requester email.
 *
 * Nothing is stored; the address only appears as a hash prefix in logs.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const apiGuard = rateLimitGuard(request, "api");
  if (apiGuard) return apiGuard;

  const started = Date.now();
  try {
    const env = getServerEnv();
    const body = await readJsonBody(
      request,
      (raw) => accessRequestSchema.parse(raw),
      ACCESS_BODY_LIMIT,
    );

    // Honeypot: hidden field, never filled by the real UI — fake success
    // so bots cannot tell they were filtered.
    if (body.website && body.website.trim().length > 0) {
      console.warn("[access:request] status=honeypot");
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    // Availability: friendly 503 the UI turns into a hidden send button.
    const fixedRecipient = env.EMAIL_FIXED_RECIPIENT?.trim() || null;
    if (!fixedRecipient || env.ACCESS_REQUEST_DAILY_CAP <= 0) {
      throw apiError(
        503,
        "ACCESS_UNAVAILABLE",
        "Access requests are unavailable right now. Please try again later.",
      );
    }

    if (turnstileEnabled()) {
      const captchaOk = await verifyTurnstile(body.turnstileToken, getClientIp(request));
      if (!captchaOk) {
        throw apiError(403, "ACCESS_CAPTCHA_FAILED", "Captcha verification failed. Try again.");
      }
    }

    // Duplicate suppression BEFORE any quota: identical content inside the
    // 10-minute window answers success and consumes nothing.
    const contentKey = accessContentKey(body);
    if (accessWasRecentlySent(contentKey)) {
      console.log(
        `[access:request] status=duplicate key=${contentKey.slice(0, 12)} durationMs=${Date.now() - started}`,
      );
      return NextResponse.json({ ok: true, duplicate: true }, { status: 202 });
    }

    const addressHash = emailHash(body.email);
    const ip = getClientIp(request);
    const daily = accessDailyGuard({ ip, addressHash });
    if (!daily.ok) {
      return NextResponse.json(
        {
          code: "ACCESS_RATE_LIMITED",
          message: `You have reached today's limit. Try again after midnight IST (${daily.retryAfterSeconds}s).`,
        },
        { status: 429, headers: { "Retry-After": String(daily.retryAfterSeconds) } },
      );
    }

    const origin = siteUrl(env);
    const data: AccessRequestEmailData = {
      name: body.name,
      company: body.company,
      email: body.email,
      reason: body.reason,
      requestedAt: new Date().toISOString(),
      requestId: requestId(),
      siteUrl: origin || "https://rajasthan-satellite-explorer.vercel.app",
    };

    const rendered = await renderAccessRequestEmail(data);

    const provider = getEmailProvider(env);
    try {
      const result = await provider.send({
        to: fixedRecipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        replyTo: body.email,
      });
      console.log(
        `[access:request] status=sent provider=${result.provider} ` +
          `id=${data.requestId} email=${addressHash.slice(0, 12)} ip=${ip} ` +
          `htmlBytes=${Buffer.byteLength(rendered.html, "utf8")} ` +
          `durationMs=${Date.now() - started}`,
      );
      accessMarkSent(contentKey);
      return NextResponse.json({ ok: true }, { status: 202 });
    } catch (error) {
      if (error instanceof EmailSendError) throw error;
      console.warn(
        `[access:request] status=send-failed id=${data.requestId} ${error instanceof Error ? error.message : String(error)}`,
      );
      throw apiError(502, "ACCESS_SEND_FAILED", "Your request could not be sent. Try again shortly.");
    }
  } catch (error) {
    const err = error as { code?: string };
    console.warn(
      `[access:request] status=failed code=${err.code ?? "UNKNOWN"} durationMs=${Date.now() - started}`,
    );
    return errorResponse(error);
  }
}
