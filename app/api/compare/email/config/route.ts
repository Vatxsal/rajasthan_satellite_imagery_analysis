import { NextResponse } from "next/server";
import { assertEmailReady, maskEmail } from "@/lib/email/index";
import { emailDailyCapReached } from "@/lib/email/rate";
import { getServerEnv } from "@/lib/env";
import { turnstileEnabled } from "@/lib/server/turnstile";

export const runtime = "nodejs";

/**
 * Public capabilities for the Email report button — never any secrets.
 * `enabled` mirrors the send route's own assertEmailReady, so a console
 * provider in production (or any incomplete setup) hides the button instead
 * of offering a submit that would 503. `mode` tells the dialog whether a
 * fixed recipient is configured (`fixed` → confirm-only UI, no email input);
 * `recipientHint` is the masked form (m***@gmail.com) — the full address is
 * server-only and never leaves this process. `provider` lets the dev dialog
 * show a quiet "preview mode" note. The Turnstile site key is exposed only
 * when the server really enforces it (secret + key configured together); a
 * secret without a key would reject every send, so the button stays hidden.
 * `dailyCapReached` lets the UI pre-empt a send that would 429.
 */
export function GET(): NextResponse {
  let enabled = false;
  let provider = "console";
  let mode: "fixed" | "open" = "open";
  let recipientHint: string | null = null;
  let summaryAvailable = false;
  let captchaRequired = false;
  let dailyCapReached = false;
  let turnstileSiteKey: string | null = null;
  let reason: string | null = null;
  try {
    const env = getServerEnv();
    provider = env.EMAIL_PROVIDER;
    mode = env.EMAIL_FIXED_RECIPIENT ? "fixed" : "open";
    recipientHint = env.EMAIL_FIXED_RECIPIENT ? maskEmail(env.EMAIL_FIXED_RECIPIENT) : null;
    summaryAvailable = Boolean(env.GEMINI_API_KEY);
    captchaRequired = turnstileEnabled();
    dailyCapReached = emailDailyCapReached();
    assertEmailReady(env);
    enabled = !(env.TURNSTILE_SECRET_KEY && !env.TURNSTILE_SITE_KEY);
    if (env.TURNSTILE_SECRET_KEY && !env.TURNSTILE_SITE_KEY) {
      reason = "TURNSTILE_SECRET_KEY is set without TURNSTILE_SITE_KEY.";
    }
    if (env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY) {
      turnstileSiteKey = env.TURNSTILE_SITE_KEY;
    }
    if (
      mode === "open" &&
      process.env.NODE_ENV === "production" &&
      !env.EMAIL_ALLOW_ANY_RECIPIENT
    ) {
      enabled = false;
      reason =
        "Typed-address mode is disabled in production (set EMAIL_FIXED_RECIPIENT or EMAIL_ALLOW_ANY_RECIPIENT=true).";
    }
  } catch (error) {
    enabled = false;
    reason = error instanceof Error ? error.message : String(error);
  }
  console.log(
    `[compare:email-config] enabled=${enabled} provider=${provider} mode=${mode} captcha=${captchaRequired}`,
  );
  return NextResponse.json(
    {
      enabled,
      mode,
      recipientHint,
      summaryAvailable,
      captchaRequired,
      dailyCapReached,
      provider,
      turnstileSiteKey,
      reason,
    },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
