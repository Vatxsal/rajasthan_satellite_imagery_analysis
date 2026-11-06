import { getServerEnv } from "@/lib/env";

/**
 * Cloudflare Turnstile verification for the email-report route.
 * A blank TURNSTILE_SECRET_KEY disables the check entirely (feature stays
 * usable without configuring CAPTCHA).
 */
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TIMEOUT_MS = 10_000;

/** True when CAPTCHA is configured (the route then requires a valid token). */
export function turnstileEnabled(): boolean {
  return Boolean(getServerEnv().TURNSTILE_SECRET_KEY);
}

/**
 * Verifies a Turnstile response token. Returns false on a missing token,
 * an explicit failure, or a network/timeout error — fail closed whenever
 * the feature is enabled.
 */
export async function verifyTurnstile(token: string | undefined, remoteIp?: string): Promise<boolean> {
  const secret = getServerEnv().TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret, response: token });
    if (remoteIp) form.set("remoteip", remoteIp);
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      console.warn(`[turnstile] siteverify HTTP ${response.status}`);
      return false;
    }
    const data = (await response.json()) as { success?: boolean; "error-codes"?: string[] };
    if (data.success !== true) {
      // Error codes only — never the token or secret.
      console.warn(`[turnstile] verify failed codes=${(data["error-codes"] ?? []).join(",")}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn(`[turnstile] verify error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
