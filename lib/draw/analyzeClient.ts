/**
 * Draw & analyze — client for POST /api/shapes/analyze.
 *
 * Mirrors lib/compare/run.ts: stage frames arrive in order, then one result
 * frame (or a mid-stream error frame). Pre-stream failures (validation, rate
 * limit, mock mode) surface as normal JSON errors and become
 * ShapeAnalyzeError — the SHAPE_INVALID body also carries `validity`, which
 * is passed through for a faithful message.
 */
import type { AreaRef } from "@/lib/server/areaRef";
import type { DrawValidity, DrawMetrics } from "@/lib/draw/geometry";
import type { ShapeStats } from "@/lib/draw/stats";

export type ShapeAnalyzeStage = "render" | "stats";

export interface ShapeAnalyzeResult {
  areaId: string;
  date: string;
  cloudCover: number;
  satellite: string;
  /** Estimated processing units of the render (CDSE formula). */
  pu: number;
  metrics: DrawMetrics | null;
  stats: ShapeStats;
}

/** Failures carry the same { code, message } contract as the API routes. */
export class ShapeAnalyzeError extends Error {
  readonly code: string;
  /** Present for SHAPE_INVALID pre-stream failures. */
  readonly validity?: DrawValidity;

  constructor(code: string, message: string, validity?: DrawValidity) {
    super(message);
    this.name = "ShapeAnalyzeError";
    this.code = code;
    this.validity = validity;
  }
}

type Frame =
  | { type: "stage"; stage: ShapeAnalyzeStage }
  | ({ type: "result" } & ShapeAnalyzeResult)
  | { type: "error"; code: string; message: string };

interface StreamOptions {
  signal?: AbortSignal;
  onStage?: (stage: ShapeAnalyzeStage) => void;
}

export interface ShapeAnalyzeRequestBody {
  area: AreaRef;
  fromDate: string;
  toDate: string;
}

/**
 * POSTs /api/shapes/analyze and consumes the NDJSON progress stream.
 * Resolves with the result frame; rejects with ShapeAnalyzeError on any
 * pre-stream or mid-stream failure.
 */
export async function streamShapeAnalyze(
  body: ShapeAnalyzeRequestBody,
  options: StreamOptions = {},
): Promise<ShapeAnalyzeResult> {
  const response = await fetch("/api/shapes/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("ndjson")) {
    const payload = (await response.json().catch(() => null)) as
      | { code?: string; message?: string; validity?: DrawValidity }
      | null;
    throw new ShapeAnalyzeError(
      payload?.code ?? `HTTP_${response.status}`,
      payload?.message ?? "Shape analysis failed. Try again shortly.",
      payload?.validity,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ShapeAnalyzeError("NO_STREAM", "The analysis stream is unavailable in this browser.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: ShapeAnalyzeResult | null = null;

  /** Parses one frame line; returns the result payload when present. */
  const consume = (raw: string): ShapeAnalyzeResult | null => {
    const frame = JSON.parse(raw) as Frame;
    if (frame.type === "stage") {
      options.onStage?.(frame.stage);
      return null;
    }
    if (frame.type === "error") {
      throw new ShapeAnalyzeError(frame.code, frame.message);
    }
    return {
      areaId: frame.areaId,
      date: frame.date,
      cloudCover: frame.cloudCover,
      satellite: frame.satellite,
      pu: frame.pu,
      metrics: frame.metrics,
      stats: frame.stats,
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
    throw new ShapeAnalyzeError("EMPTY_STREAM", "The analysis stream ended without a result.");
  }
  return result;
}
