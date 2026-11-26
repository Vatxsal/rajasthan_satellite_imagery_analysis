/** Upstream CDSE/Sentinel Hub failure with a UI-friendly mapping. */
export class CdseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CdseHttpError";
    // The test/dev build downlevels classes to ES5, where `extends Error`
    // returns a plain Error — restore the prototype so `instanceof` holds.
    Object.setPrototypeOf(this, CdseHttpError.prototype);
  }
}

interface UpstreamAuthDetail {
  /** OAuth `error` field from the token endpoint (e.g. "invalid_client"). */
  oauthError?: string;
  /** Human-readable detail: `error_description` / `description` / nested `message`. */
  detail?: string;
}

/**
 * Reads the OAuth / Sentinel Hub error fields from a response body so failures
 * can name their real cause (never sees credentials — upstream responses only).
 * Shapes handled: Keycloak `{ error, error_description }`, catalogue
 * `{ code, description }`, Sentinel Hub `{ error: { message } }`.
 */
function readAuthDetail(bodyText?: string): UpstreamAuthDetail {
  if (!bodyText) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return {};
  }
  const nested =
    parsed.error && typeof parsed.error === "object"
      ? (parsed.error as Record<string, unknown>)
      : undefined;
  const raw =
    (typeof parsed.error_description === "string" ? parsed.error_description : undefined) ??
    (typeof parsed.description === "string" ? parsed.description : undefined) ??
    (typeof nested?.message === "string" ? nested.message : undefined);
  const detail = raw?.replace(/\s+/g, " ").trim().slice(0, 160);
  return {
    oauthError: typeof parsed.error === "string" ? parsed.error : undefined,
    detail: detail || undefined,
  };
}

/** Sentinel Hub 400 payload: { error: { status, reason, message, code, errors: [...] } }. */
interface ShBadRequestError {
  status?: number;
  reason?: string;
  message?: string;
  code?: string;
  errors?: Array<{
    parameter?: string;
    invalidValue?: unknown;
    violation?: string;
  }>;
}

/** Reads the Sentinel Hub 400 violation list into a human-readable line. */
function readBadRequestDetail(bodyText?: string): string | null {
  if (!bodyText) return null;
  let parsed: { error?: unknown };
  try {
    parsed = JSON.parse(bodyText) as { error?: unknown };
  } catch {
    return null;
  }
  const error = parsed.error;
  if (!error || typeof error !== "object") return null;
  const bad = error as ShBadRequestError;
  const violations = (bad.errors ?? [])
    .map((item) => {
      const parameter = item.parameter ? String(item.parameter) : "";
      const value = item.invalidValue !== undefined ? ` ${String(item.invalidValue)}` : "";
      const violation = item.violation ? String(item.violation).replace(/[.\s]+$/, "") : "";
      if (!parameter && !violation) return null;
      return `${parameter || "a field"}${value}${violation ? ` — ${violation}` : ""}`;
    })
    .filter((line): line is string => line !== null);
  if (violations.length > 0) {
    const intro = bad.message ? `${bad.message}: ` : "";
    return `${intro}${violations.join("; ")}`;
  }
  return typeof bad.message === "string" ? bad.message : null;
}

/** True when a 429 body says the processing-unit QUOTA is gone (not a
 *  transient rate limit — retrying cannot help, the user must stop). */
function isQuotaExhaustion(bodyText?: string): boolean {
  return /quota|processing units|exhaust|no more credits/i.test(bodyText ?? "");
}

/** Maps CDSE HTTP statuses to clear JSON error contracts. Body text is truncated. */
export function mapCdseStatus(status: number, bodyText?: string): CdseHttpError {
  const { oauthError, detail } = readAuthDetail(bodyText);

  // Token endpoint rejected the OAuth client itself — name the OAuth error
  // instead of one generic authentication message.
  if (oauthError === "invalid_client") {
    return new CdseHttpError(
      502,
      "CDSE_AUTH",
      `Copernicus rejected the OAuth client (invalid_client): ${
        detail ? `${detail.replace(/[.\s]+$/, "")}. ` : ""
      }recreate the OAuth client (Dashboard > User settings > OAuth clients) and ` +
        "update CDSE_CLIENT_ID / CDSE_CLIENT_SECRET.",
    );
  }

  if (status === 401 || status === 403) {
    // Surface the upstream reason when present: a 403 "Invalid or expired
    // account" is an account/plan problem, not bad client credentials.
    if (detail) {
      const clean = detail.replace(/[.\s]+$/, "");
      const accountIssue = /expired|invalid account|insufficient|subscription|plan/i.test(clean);
      return new CdseHttpError(
        502,
        "CDSE_AUTH",
        `Copernicus rejected the request (HTTP ${status}): ${clean}.` +
          (accountIssue
            ? " The Copernicus account has no active plan/trial — renew or activate it in the Data Space dashboard."
            : ""),
      );
    }
    return new CdseHttpError(
      502,
      "CDSE_AUTH",
      "Copernicus authentication failed. Check CDSE_CLIENT_ID / CDSE_CLIENT_SECRET.",
    );
  }
  if (status === 400) {
    // Deterministic payload rejection — name the parameter and the rule so
    // the UI never has to show raw upstream JSON. Never retried upstream.
    const violation = readBadRequestDetail(bodyText);
    return new CdseHttpError(
      400,
      "CDSE_BAD_REQUEST",
      violation
        ? `Copernicus rejected the request — ${violation}.`
        : "Copernicus rejected the request payload (HTTP 400). Check the area and resolution settings.",
    );
  }
  if (status === 429) {
    // Two very different causes share this status: the per-minute rate limit
    // (retryable) and processing-unit exhaustion (stop immediately).
    if (isQuotaExhaustion(bodyText)) {
      return new CdseHttpError(
        429,
        "CDSE_QUOTA",
        "The Copernicus processing-unit quota for this account is exhausted — no further requests were attempted. Check the Data Space dashboard.",
      );
    }
    return new CdseHttpError(
      429,
      "CDSE_RATE_LIMIT",
      "Copernicus rate limit reached — retrying automatically. Frequent large requests can trigger this.",
    );
  }
  if (status === 402) {
    return new CdseHttpError(
      402,
      "CDSE_QUOTA",
      "The Copernicus processing-unit quota is exhausted (HTTP 402) — no further requests were attempted. Check the Data Space dashboard.",
    );
  }
  const snippet = (bodyText ?? "").slice(0, 200).replace(/\s+/g, " ").trim();
  return new CdseHttpError(
    502,
    "CDSE_UPSTREAM",
    snippet ? `Copernicus service error: ${snippet}` : "Copernicus service request failed.",
  );
}
