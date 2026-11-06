import { NextResponse } from "next/server";
import { assertEmailReady } from "@/lib/email/index";
import { getServerEnv } from "@/lib/env";

export const runtime = "nodejs";

/**
 * Public capabilities for the Email report button — never any secrets.
 * `enabled` mirrors the send route's own assertEmailReady, so a console
 * provider in production (or any incomplete setup) hides the button instead
 * of offering a submit that would 503. `provider` lets the dev dialog show a
 * quiet "preview mode" note. The Turnstile site key is exposed only when the
 * server really enforces it (secret + key configured together); a secret
 * without a key would reject every send, so the button stays hidden.
 */
export function GET(): NextResponse {
  let enabled = false;
  let provider = "console";
  let turnstileSiteKey: string | null = null;
  let reason: string | null = null;
  try {
    const env = getServerEnv();
    provider = env.EMAIL_PROVIDER;
    assertEmailReady(env);
    enabled = !(env.TURNSTILE_SECRET_KEY && !env.TURNSTILE_SITE_KEY);
    if (env.TURNSTILE_SECRET_KEY && !env.TURNSTILE_SITE_KEY) {
      reason = "TURNSTILE_SECRET_KEY is set without TURNSTILE_SITE_KEY.";
    }
    if (env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY) {
      turnstileSiteKey = env.TURNSTILE_SITE_KEY;
    }
  } catch (error) {
    enabled = false;
    reason = error instanceof Error ? error.message : String(error);
  }
  console.log(`[compare:email-config] enabled=${enabled} provider=${provider}`);
  return NextResponse.json(
    { enabled, provider, turnstileSiteKey, reason },
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
