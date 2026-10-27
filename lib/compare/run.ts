import type { AnalyzeResponse } from "@/lib/analysis/types";
import type { CompareStage } from "@/store/useCompareStore";

export interface AnalyzeRequestBody {
  areaId: string;
  level: "district" | "tehsil" | "ilr";
  dateA: string;
  dateB: string;
  sensitivity: "low" | "medium" | "high";
  minPatchHa: number;
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
  | { type: "stage"; stage: CompareStage }
  | { type: "result"; key: string; overlayUrl: string; aiEnabled: boolean; stats: AnalyzeResponse["stats"] }
  | { type: "error"; code: string; message: string };

interface StreamOptions {
  signal?: AbortSignal;
  onStage?: (stage: CompareStage) => void;
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
      options.onStage?.(frame.stage);
      return null;
    }
    if (frame.type === "error") {
      throw new CompareRunError(frame.code, frame.message);
    }
    return { key: frame.key, overlayUrl: frame.overlayUrl, aiEnabled: frame.aiEnabled, stats: frame.stats };
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
