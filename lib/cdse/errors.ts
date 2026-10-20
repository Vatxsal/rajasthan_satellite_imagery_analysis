/** Upstream CDSE/Sentinel Hub failure with a UI-friendly mapping. */
export class CdseHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CdseHttpError";
  }
}

/** Maps CDSE HTTP statuses to clear JSON error contracts. Body text is truncated. */
export function mapCdseStatus(status: number, bodyText?: string): CdseHttpError {
  if (status === 401 || status === 403) {
    return new CdseHttpError(
      502,
      "CDSE_AUTH",
      "Copernicus authentication failed. Check CDSE_CLIENT_ID / CDSE_CLIENT_SECRET.",
    );
  }
  if (status === 429) {
    return new CdseHttpError(
      429,
      "CDSE_QUOTA",
      "Monthly quota reached, try again later.",
    );
  }
  if (status === 402) {
    return new CdseHttpError(
      402,
      "CDSE_QUOTA",
      "Monthly quota reached, try again later.",
    );
  }
  const snippet = (bodyText ?? "").slice(0, 200).replace(/\s+/g, " ").trim();
  return new CdseHttpError(
    502,
    "CDSE_UPSTREAM",
    snippet ? `Copernicus service error: ${snippet}` : "Copernicus service request failed.",
  );
}
