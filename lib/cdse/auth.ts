import { getServerEnv } from "@/lib/env";
import { sharedInstance } from "../singleton";
import { CdseHttpError, mapCdseStatus } from "./errors";

interface TokenInfo {
  accessToken: string;
  /** Epoch millis when the token should be considered stale. */
  validUntil: number;
  expiresIn: number;
}

/** Process-wide token state — one refresh no matter how many route graphs load this module. */
const tokenState = sharedInstance("rse.cdseAuth", () => ({
  cached: null as TokenInfo | null,
  inflight: null as Promise<TokenInfo> | null,
}));

/** Refresh 60s before the reported expiry to avoid using a dying token. */
const SAFETY_MARGIN_MS = 60_000;

/**
 * Trim + strip one layer of surrounding quotes from an env-provided credential.
 * Catches values pasted as `"…"` or `'…'` — those still parse as "set" but the
 * token endpoint rejects them with invalid_client.
 */
export function sanitizeCredential(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  const quoted = /^(["'])([\s\S]*)\1$/.exec(trimmed);
  return (quoted ? quoted[2] : trimmed).trim();
}

async function requestToken(): Promise<TokenInfo> {
  const env = getServerEnv();
  const clientId = sanitizeCredential(env.CDSE_CLIENT_ID);
  const clientSecret = sanitizeCredential(env.CDSE_CLIENT_SECRET);
  if (!clientId || !clientSecret) {
    // "Missing env var" is distinct from "credentials rejected" (401/403 below).
    const missing = [
      clientId ? null : "CDSE_CLIENT_ID",
      clientSecret ? null : "CDSE_CLIENT_SECRET",
    ]
      .filter(Boolean)
      .join(" and ");
    throw new CdseHttpError(
      500,
      "CDSE_CONFIG",
      `${missing} missing or empty — set ${missing} in the server environment ` +
        "(required when NEXT_PUBLIC_DATA_SOURCE=cdse).",
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetch(env.CDSE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // Log status + OAuth error only — never the client id/secret (the upstream
    // body never echoes them either).
    let oauth: { error?: unknown; error_description?: unknown } = {};
    try {
      oauth = JSON.parse(text) as typeof oauth;
    } catch {
      /* non-JSON body — mapCdseStatus handles the snippet fallback */
    }
    const oauthError = typeof oauth.error === "string" ? oauth.error : undefined;
    const description =
      typeof oauth.error_description === "string"
        ? oauth.error_description.replace(/\s+/g, " ").slice(0, 200)
        : undefined;
    console.error(
      `[cdse:auth] token endpoint HTTP ${response.status}` +
        (oauthError ? ` error=${oauthError}` : "") +
        (description ? ` description=${description}` : ""),
    );
    // Failed tokens are never cached — ensureToken only stores on success.
    throw mapCdseStatus(response.status, text);
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
  if (tokenState.cached && tokenState.cached.validUntil > Date.now()) {
    return tokenState.cached;
  }
  if (!tokenState.inflight) {
    tokenState.inflight = requestToken()
      .then((info) => {
        tokenState.cached = info;
        return info;
      })
      .finally(() => {
        tokenState.inflight = null;
      });
  }
  return tokenState.inflight;
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
