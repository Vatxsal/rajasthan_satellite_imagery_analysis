import { NextResponse } from "next/server";
import { z } from "zod";
import {
  buildSummaryPrompt,
  SUMMARY_IMAGES_NOTE,
  SUMMARY_MODEL_FALLBACK,
  SUMMARY_RESPONSE_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  summaryLanguageLine,
  summaryOutputSchema,
  type SummaryOutput,
} from "@/lib/analysis/prompt";
import { aiSummaryCache, summaryCacheKey, type CompareArtifactEntry } from "@/lib/cache";
import { buildShareUrl } from "@/lib/compare/shareLink";
import { dataSource, getServerEnv } from "@/lib/env";
import {
  assertEmailReady,
  emailHash,
  getEmailProvider,
  isValidEmail,
  normalizeEmail,
  siteUrl,
  EmailSendError,
  type EmailInlineImage,
} from "@/lib/email";
import { emailMarkSent, emailSendKey, emailWasRecentlySent } from "@/lib/email/dedupe";
import { dailyLimitMessage, emailDailyGuard } from "@/lib/email/rate";
import {
  buildEventsCsv,
  buildReportEmailData,
  renderReportEmail,
} from "@/lib/email/template";
import { getClientIp } from "@/lib/rateLimit";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";
import {
  compareParamsSchema,
  ensureCompare,
  MOCK_SOURCE_MESSAGE,
  resolveCompareParams,
} from "@/lib/server/compareRun";
import {
  assertGeminiKey,
  codedError,
  generateWithFallback,
  type GeminiImagePart,
} from "@/lib/server/gemini";
import {
  buildChangeMapJpeg,
  buildSummaryImages,
} from "@/lib/server/summaryImages";
import { turnstileEnabled, verifyTurnstile } from "@/lib/server/turnstile";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMAIL_BODY_LIMIT = 8_000;
const SUMMARY_TTL_SECONDS = 1_800;
const CHANGE_MAP_CID = "changemap";

const IMAGE_LABELS = [
  "Image 1 — date A (true colour):",
  "Image 2 — date B (true colour):",
  "Image 3 — classified change overlay on date B:",
];

/**
 * POST /api/compare/email
 *
 * Two recipient modes:
 *   fixed (EMAIL_FIXED_RECIPIENT set) — the body must NOT carry an `email`
 *     field (400 EMAIL_INVALID if it does); the recipient comes only from
 *     the server-side env var, so a client can never choose a recipient.
 *   open — the body carries `email`, but production refuses typed-address
 *     sending (503 EMAIL_DISABLED) unless EMAIL_ALLOW_ANY_RECIPIENT=true.
 *
 * Body: { email?, params, language?, includeSummary?, includeImage?,
 *         turnstileToken?, website? }. `params` carries only the analysis
 * inputs — every number in the report is recomputed server-side through the
 * same cache/stateless path as /api/compare/analyze (never trusted from the
 * client). Guards: same-origin, per-minute api+compare buckets, honeypot,
 * optional Turnstile, duplicate-send suppression (10 min window, no quota),
 * then daily per-IP/per-address/deployment quotas.
 * Responds 202 { ok: true[, alreadySent: true] }; failures carry EMAIL_* codes.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const apiGuard = rateLimitGuard(request, "api");
  if (apiGuard) return apiGuard;
  const compareGuard = rateLimitGuard(request, "compare");
  if (compareGuard) return compareGuard;

  const started = Date.now();
  try {
    const env = getServerEnv();
    const fixedRecipient = env.EMAIL_FIXED_RECIPIENT?.trim() || null;

    const body = await readJsonBody(
      request,
      (raw) => emailBodySchema.parse(raw),
      EMAIL_BODY_LIMIT,
    );

    // Honeypot: hidden field, never filled by the real UI — fake success
    // so bots cannot tell they were filtered.
    if (body.website && body.website.trim().length > 0) {
      console.warn("[compare:email] status=honeypot");
      return NextResponse.json({ ok: true }, { status: 202 });
    }

    // Recipient: fixed mode takes it ONLY from the env var (a client-supplied
    // email field is rejected outright); open mode validates the typed address
    // and production refuses typed mode unless explicitly allowed.
    let recipient: string;
    if (fixedRecipient) {
      if (body.email !== undefined) {
        throw new EmailSendError(
          "EMAIL_INVALID",
          "This deployment sends reports to a configured address — do not include an email in the request.",
          400,
        );
      }
      recipient = normalizeEmail(fixedRecipient);
    } else {
      if (process.env.NODE_ENV === "production" && !env.EMAIL_ALLOW_ANY_RECIPIENT) {
        throw new EmailSendError(
          "EMAIL_DISABLED",
          "Typed-address sending is disabled on this deployment. Set EMAIL_FIXED_RECIPIENT or EMAIL_ALLOW_ANY_RECIPIENT=true.",
          503,
        );
      }
      recipient = normalizeEmail(body.email ?? "");
      if (!isValidEmail(recipient)) {
        throw new EmailSendError("EMAIL_INVALID", "Enter a valid email address.", 400);
      }
    }

    if (turnstileEnabled()) {
      const captchaOk = await verifyTurnstile(body.turnstileToken, getClientIp(request));
      if (!captchaOk) {
        throw new EmailSendError(
          "EMAIL_CAPTCHA_FAILED",
          "Captcha verification failed. Try again.",
          403,
        );
      }
    }

    // Duplicate suppression BEFORE any quota: the same report that already
    // went out in the last 10 minutes answers success with alreadySent=true
    // and consumes nothing.
    const sendKey = emailSendKey({
      params: body.params,
      language: body.language,
      includeSummary: body.includeSummary,
      includeImage: body.includeImage,
      engine: env.CHANGE_ENGINE,
      recipientHash: emailHash(recipient),
    });
    if (emailWasRecentlySent(sendKey)) {
      console.log(
        `[compare:email] status=already-sent key=${sendKey.slice(0, 12)} durationMs=${Date.now() - started}`,
      );
      return NextResponse.json({ ok: true, alreadySent: true }, { status: 202 });
    }

    const daily = emailDailyGuard({
      ip: getClientIp(request),
      addressHash: emailHash(recipient),
    });
    if (!daily.ok) {
      throw new EmailSendError(
        "EMAIL_RATE_LIMITED",
        dailyLimitMessage(daily.retryAfterSeconds),
        429,
        daily.retryAfterSeconds,
      );
    }

    // Fail fast BEFORE any analysis work: console provider / missing config.
    assertEmailReady(env);
    if (dataSource === "mock") {
      throw apiError(400, "CDSE_CONFIG", MOCK_SOURCE_MESSAGE);
    }

    const resolved = resolveCompareParams(body.params);

    let entry: CompareArtifactEntry;
    try {
      ({ entry } = await ensureCompare(resolved));
    } catch (error) {
      const err = error as { code?: string; status?: number };
      if (typeof err.code === "string" && typeof err.status === "number") throw error;
      console.warn(
        `[compare:email] analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new EmailSendError(
        "EMAIL_ANALYSIS_FAILED",
        "The analysis could not be prepared for the report. Try again shortly.",
        502,
      );
    }

    const origin = siteUrl(env);
    if (!origin) {
      throw new EmailSendError(
        "EMAIL_DISABLED",
        "Email sending is not configured (NEXT_PUBLIC_SITE_URL is missing).",
        503,
      );
    }

    const deepLink = buildShareUrl(
      origin,
      {
        areaId: resolved.area.id,
        level: resolved.area.level,
        dateA: resolved.dateA,
        dateB: resolved.dateB,
        sensitivity: resolved.sensitivity,
        minPatchHa: resolved.minPatchHa,
        inputMode: resolved.inputMode,
      },
      { tab: "events" },
    );

    // AI summary: shared cache with the Summary tab; any failure degrades to
    // a report without the summary — never blocks the send.
    let summary: SummaryData | null = null;
    let summaryUnavailable = false;
    if (body.includeSummary) {
      if (!resolved.aiEnabled) {
        summaryUnavailable = true;
      } else {
        try {
          const loaded = await loadOrGenerateSummary({
            analysisKey: resolved.key,
            language: body.language,
            env,
            request,
            stats: entry.stats,
            events: entry.events,
            geometry: entry.geometry,
            overlayPng: entry.overlayPng,
            dateA: resolved.dateA,
            dateB: resolved.dateB,
          });
          summary = loaded.summary;
          summaryUnavailable = loaded.summary === null;
        } catch (error) {
          console.warn(
            `[compare:email] summary degraded: ${error instanceof Error ? error.message : String(error)}`,
          );
          summaryUnavailable = true;
        }
      }
    }

    const metadata = entry.stats.metadata;
    const dataWithoutImage = buildReportEmailData({
      language: body.language,
      areaName: metadata.areaName,
      areaLevel: metadata.areaLevel,
      dateA: metadata.dateA,
      dateB: metadata.dateB,
      gapDays: metadata.gapDays,
      sensitivity: metadata.sensitivity,
      minPatchHa: metadata.minPatchHa,
      inputMode: metadata.inputMode,
      stats: {
        classes: entry.stats.classes,
        validPct: entry.stats.validPct,
        validHa: entry.stats.validHa,
        changedHa: entry.stats.changedHa,
        tehsils: entry.stats.tehsils,
        eventsTotal: entry.stats.eventsTotal,
      },
      events: entry.events.features,
      summary,
      includeSummary: body.includeSummary,
      summaryUnavailable,
      image: null,
      deepLink,
      siteUrl: origin,
      generatedAt: metadata.generatedAt,
    });

    // Two-pass image budget: measure the markup first, then ask the JPEG
    // encoder to fit whatever base64 headroom remains under the 100 KB cap.
    let image = dataWithoutImage.image;
    let inlineImages: EmailInlineImage[] | undefined;
    if (body.includeImage) {
      const probe = await renderReportEmail(dataWithoutImage);
      const markupBytes = Buffer.byteLength(probe.html, "utf8");
      const imageBudgetBytes = Math.floor(((100_000 - markupBytes - 2_048) * 3) / 4);
      if (imageBudgetBytes >= 4_000) {
        const map = await buildChangeMapJpeg({
          geometry: entry.geometry,
          dateB: resolved.dateB,
          overlayPng: entry.overlayPng,
          maxPx: 700,
          maxBytes: imageBudgetBytes,
        });
        if (map) {
          image = {
            src: `cid:${CHANGE_MAP_CID}`,
            width: map.width,
            height: map.height,
            alt: body.language === "hi" ? "परिवर्तन मानचित्र" : "Change map",
          };
          inlineImages = [
            {
              cid: CHANGE_MAP_CID,
              filename: "change-map.jpg",
              content: map.content,
              contentType: "image/jpeg",
            },
          ];
        } else {
          console.warn("[compare:email] change map dropped (budget)");
        }
      } else {
        console.warn("[compare:email] change map dropped (no HTML headroom)");
      }
    }

    const data = image ? { ...dataWithoutImage, image } : dataWithoutImage;
    const rendered = await renderReportEmail(data);

    const attachments =
      env.EMAIL_ATTACH_CSV && entry.events.features.length > 0
        ? [
            {
              filename: "events.csv",
              content: Buffer.from(buildEventsCsv(entry.events.features, deepLink), "utf8"),
              contentType: "text/csv; charset=utf-8",
            },
          ]
        : undefined;

    const provider = getEmailProvider(env);
    try {
      const result = await provider.send({
        to: recipient,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        attachments,
        inlineImages,
      });
      console.log(
        `[compare:email] status=sent provider=${result.provider} ` +
          `to=${emailHash(recipient).slice(0, 12)} htmlBytes=${Buffer.byteLength(rendered.html, "utf8")} ` +
          `summary=${summary ? "yes" : summaryUnavailable ? "no" : "skipped"} ` +
          `image=${image ? "yes" : "no"} csv=${attachments ? "yes" : "no"} ` +
          `durationMs=${Date.now() - started}`,
      );
      emailMarkSent(sendKey);
      return NextResponse.json({ ok: true }, { status: 202 });
    } catch (error) {
      if (error instanceof EmailSendError) throw error;
      console.warn(
        `[compare:email] send failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new EmailSendError(
        "EMAIL_SEND_FAILED",
        "The report could not be sent. Try again shortly.",
        502,
      );
    }
  } catch (error) {
    const err = error as { code?: string; status?: number; retryAfterSeconds?: number };
    console.warn(
      `[compare:email] status=failed code=${err.code ?? "UNKNOWN"} durationMs=${Date.now() - started}`,
    );
    if (typeof err.retryAfterSeconds === "number") {
      const response = errorResponse(error);
      response.headers.set("Retry-After", String(err.retryAfterSeconds));
      return response;
    }
    return errorResponse(error);
  }
}

const emailBodySchema = z.object({
  /** Open mode only — fixed mode rejects any body that carries this field. */
  email: z.string().trim().max(254).optional(),
  params: compareParamsSchema,
  language: z.enum(["en", "hi"]).default("en"),
  includeSummary: z.boolean().default(true),
  includeImage: z.boolean().default(true),
  turnstileToken: z.string().max(4_096).optional(),
  /** Honeypot — hidden in the UI, absent from this schema's happy path. */
  website: z.string().max(256).optional(),
});

type SummaryData = SummaryOutput;

async function loadOrGenerateSummary(input: {
  analysisKey: string;
  language: "en" | "hi";
  env: ReturnType<typeof getServerEnv>;
  request: Request;
  stats: Parameters<typeof buildSummaryPrompt>[0];
  events: Parameters<typeof buildSummaryPrompt>[1];
  geometry: Parameters<typeof buildSummaryImages>[0]["geometry"];
  overlayPng: Buffer;
  dateA: string;
  dateB: string;
}): Promise<{ summary: SummaryOutput | null }> {
  const { env } = input;
  const cacheKey = summaryCacheKey({
    analysisKey: input.analysisKey,
    language: input.language,
    includeImages: true,
  });
  const cached = aiSummaryCache.get(cacheKey);
  if (cached) {
    const parsed = JSON.parse(cached.toString("utf8")) as
      | SummaryOutput
      | { summary?: SummaryOutput; imagesFallback?: boolean };
    const envelope =
      typeof (parsed as { summary?: unknown }).summary === "object" &&
      (parsed as { summary?: unknown }).summary !== null;
    const summary = envelope
      ? (parsed as { summary: SummaryOutput }).summary
      : (parsed as SummaryOutput);
    return { summary };
  }

  // Same AI bucket as the Summary tab — an email burst cannot starve it.
  const aiGuard = rateLimitGuard(input.request, "ai");
  if (aiGuard) return { summary: null };

  const apiKey = assertGeminiKey(env.GEMINI_API_KEY);
  const model = env.GEMINI_MODEL || SUMMARY_MODEL_FALLBACK;
  const built = await buildSummaryImages({
    geometry: input.geometry,
    dateA: input.dateA,
    dateB: input.dateB,
    overlayPng: input.overlayPng,
  });
  const images: GeminiImagePart[] = built.map((image) => ({
    mimeType: image.mimeType,
    data: image.data,
  }));

  const prompt = [
    summaryLanguageLine(input.language),
    "",
    buildSummaryPrompt(input.stats, input.events),
    "",
    SUMMARY_IMAGES_NOTE,
  ].join("\n");

  const options = {
    apiKey,
    model,
    systemInstruction: SUMMARY_SYSTEM_PROMPT,
    prompt,
    responseSchema: SUMMARY_RESPONSE_SCHEMA,
    images,
    imageLabels: IMAGE_LABELS,
    timeoutMs: 45_000,
  };

  let summary: SummaryOutput | null = null;
  let lastValidationError: z.ZodError | null = null;
  for (let attempt = 0; attempt < 2 && !summary; attempt++) {
    const generated = await generateWithFallback(options);
    const result = summaryOutputSchema.safeParse(generated.data);
    if (result.success) {
      summary = result.data;
    } else {
      lastValidationError = result.error;
    }
  }
  if (!summary) {
    throw codedError(
      502,
      "AI_BAD_OUTPUT",
      lastValidationError?.issues.slice(0, 2).map((issue) => issue.message).join("; ") ||
        "AI summary had an unexpected shape.",
    );
  }

  aiSummaryCache.set(
    cacheKey,
    Buffer.from(JSON.stringify({ summary, imagesFallback: false }), "utf8"),
    SUMMARY_TTL_SECONDS,
  );
  return { summary };
}
