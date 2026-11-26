import type { AnalyzeResponse } from "@/lib/analysis/types";
import type { CompareSpeckle, Sensitivity } from "@/lib/analysis/config";
import type { CompareStage } from "@/store/useCompareStore";

export interface AnalyzeRequestBody {
  areaId: string;
  level: "district" | "tehsil" | "ilr";
  dateA: string;
  dateB: string;
  sensitivity: Sensitivity;
  minPatchHa: number;
  /** Phase 2 despeckle mode (server defaults to gentle when omitted). */
  speckle?: CompareSpeckle;
  /** Engine v2 input mode (server ignores it while CHANGE_ENGINE=v1). */
  inputMode?: "single" | "composite";
  /** ±days around each date for composite inputs (0-15). */
  compositeWindowDays?: number;
  /** Phase 3 detail mode (omitted = quick). */
  detail?: "quick" | "detailed" | "smart";
  /** Phase 3: client acknowledged the estimate card (detail runs only). */
  confirm?: boolean;
}

/** Failures carry the same { code, message } contract as the API routes. */
export class CompareRunError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CompareRunError";
    this.code = code;
  }
}

type Frame =
  | { type: "stage"; stage: CompareStage; index?: number; total?: number }
  | {
      type: "result";
      key: string;
      overlayUrl: string;
      aiEnabled: boolean;
      stats: AnalyzeResponse["stats"];
      /** Inline events (first ANALYZE_EVENTS_CAP) — the Events list/markers read
       *  them from here, no follow-up fetch. Optional for older servers. */
      events?: AnalyzeResponse["events"];
      /** Phase 3: detailed/smart runs — the map switches to the tile source. */
      detail?: AnalyzeResponse["detail"];
    }
  | { type: "error"; code: string; message: string };

/** Phase 3 estimate card (POST /api/compare/detail/estimate). */
export interface DetailEstimateResponse {
  detail: "detailed" | "smart";
  blocksTotal: number;
  blocksSelected: number;
  screeningPu: number;
  blocksPu: number;
  estimatedPu: number;
  cap: number;
  overQuickLimit: boolean;
  /** Smart: effective screening resolution in m (coarsened to fit the
   *  Process API 2500-px limit on large AOIs) — null for detailed mode. */
  screeningMeters: number | null;
}

interface StreamOptions {
  signal?: AbortSignal;
  onStage?: (stage: CompareStage, block?: { index: number; total: number }) => void;
}

/**
 * POSTs /api/compare/analyze and consumes the NDJSON progress stream:
 * stage frames arrive in order, then a single result frame (or a mid-stream
 * error frame). Pre-stream failures (validation, rate limit, mock mode)
 * surface as normal JSON errors and become CompareRunError.
 */
export async function streamAnalyze(
  body: AnalyzeRequestBody,
  options: StreamOptions = {},
): Promise<AnalyzeResponse> {
  const response = await fetch("/api/compare/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("ndjson")) {
    const payload = (await response.json().catch(() => null)) as
      | { code?: string; message?: string }
      | null;
    throw new CompareRunError(
      payload?.code ?? `HTTP_${response.status}`,
      payload?.message ?? "Change detection request failed. Try again shortly.",
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new CompareRunError("NO_STREAM", "The analysis stream is unavailable in this browser.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: AnalyzeResponse | null = null;

  /** Parses one frame line; returns the result frame payload when present. */
  const consume = (raw: string): AnalyzeResponse | null => {
    const frame = JSON.parse(raw) as Frame;
    if (frame.type === "stage") {
      options.onStage?.(
        frame.stage,
        frame.stage === "block"
          ? { index: frame.index ?? 0, total: frame.total ?? 0 }
          : undefined,
      );
      return null;
    }
    if (frame.type === "error") {
      throw new CompareRunError(frame.code, frame.message);
    }
    return {
      key: frame.key,
      overlayUrl: frame.overlayUrl,
      aiEnabled: frame.aiEnabled,
      stats: frame.stats,
      events: frame.events ?? [],
      ...(frame.detail ? { detail: frame.detail } : {}),
    };
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) result = consume(line) ?? result;
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) result = consume(buffer.trim()) ?? result;

  if (!result) {
    throw new CompareRunError("EMPTY_STREAM", "The analysis stream ended without a result.");
  }
  return result;
}

/**
 * POSTs /api/compare/detail/estimate — the Phase 3 cost card shown before the
 * confirm dialog. Smart estimates run the cached coarse screening first, so
 * the first call can take as long as one quick analysis.
 */
export async function fetchDetailEstimate(
  body: AnalyzeRequestBody,
  options: { signal?: AbortSignal } = {},
): Promise<DetailEstimateResponse> {
  const response = await fetch("/api/compare/detail/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });
  const payload = (await response.json().catch(() => null)) as
    | (DetailEstimateResponse & { code?: string; message?: string })
    | { code?: string; message?: string }
    | null;
  if (!response.ok || !payload || !("estimatedPu" in payload)) {
    const error = payload as { code?: string; message?: string } | null;
    throw new CompareRunError(
      error?.code ?? `HTTP_${response.status}`,
      error?.message ?? "Could not estimate this detailed comparison. Try again shortly.",
    );
  }
  return payload as DetailEstimateResponse;
}
