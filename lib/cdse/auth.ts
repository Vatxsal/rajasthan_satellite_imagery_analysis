import { getServerEnv } from "@/lib/env";
import { CdseHttpError, mapCdseStatus } from "./errors";

interface TokenInfo {
  accessToken: string;
  /** Epoch millis when the token should be considered stale. */
  validUntil: number;
  expiresIn: number;
}

let cachedToken: TokenInfo | null = null;
let inflight: Promise<TokenInfo> | null = null;

/** Refresh 60s before the reported expiry to avoid using a dying token. */
const SAFETY_MARGIN_MS = 60_000;

async function requestToken(): Promise<TokenInfo> {
  const env = getServerEnv();
  if (!env.CDSE_CLIENT_ID || !env.CDSE_CLIENT_SECRET) {
    throw new CdseHttpError(
      500,
      "CDSE_CONFIG",
      "CDSE_CLIENT_ID and CDSE_CLIENT_SECRET are required when NEXT_PUBLIC_DATA_SOURCE=cdse.",
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.CDSE_CLIENT_ID,
    client_secret: env.CDSE_CLIENT_SECRET,
  });

  const response = await fetch(env.CDSE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    // Never include the response body or credentials in logs/errors.
    throw mapCdseStatus(response.status);
  }

  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new CdseHttpError(502, "CDSE_AUTH", "Copernicus token response was malformed.");
  }

  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 600;
  return {
    accessToken: json.access_token,
    expiresIn,
    validUntil: Date.now() + Math.max(0, expiresIn * 1000 - SAFETY_MARGIN_MS),
  };
}

/** Returns a cached OAuth token, deduping concurrent refreshes. Secrets are never logged. */
async function ensureToken(): Promise<TokenInfo> {
  if (cachedToken && cachedToken.validUntil > Date.now()) {
    return cachedToken;
  }
  if (!inflight) {
    inflight = requestToken()
      .then((info) => {
        cachedToken = info;
        return info;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function getAccessToken(): Promise<string> {
  const info = await ensureToken();
  return info.accessToken;
}

/** Health-check helper: fetches a token and reports remaining validity (no secrets). */
export async function getTokenHealth(): Promise<{ expiresIn: number }> {
  const info = await ensureToken();
  const expiresIn = Math.max(0, Math.round((info.validUntil - Date.now()) / 1000));
  return { expiresIn };
}
