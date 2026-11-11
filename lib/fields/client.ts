/**
 * Browser clients for the fields demo (Phase 3): one plain JSON fetch for
 * POST /api/fields and one NDJSON stream consumer for POST /api/fields/pattern.
 *
 * Failures carry the same { code, message } contract as the API routes so the
 * panel can render a stable error without sniffing HTTP bodies twice.
 *
 * Pure frame parsing lives in consumePatternLine so the node test harness can
 * exercise the stream contract without a network or a DOM.
 */
import type { BBox } from "@/lib/data";
import type { FieldsYear, FieldFeature } from "@/lib/fields/query";
import type { PatternClass } from "@/lib/fields/config";
import type { PatternMetrics, PatternMonth } from "@/lib/fields/pattern";
import type { PatternGroupingInfo } from "@/lib/fields/patternRun";

/** Failures carry the same { code, message } contract as the API routes. */
export class FieldsClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 0) {
    super(message);
    this.name = "FieldsClientError";
    this.code = code;
    this.status = status;
    // ES5 downlevel (test build) loses the prototype chain on Error subclasses.
    Object.setPrototypeOf(this, FieldsClientError.prototype);
  }
}

export interface FieldsRequestBody {
  bbox: BBox;
  year: FieldsYear;
  minConfidence?: number;
}

export interface FieldsResponse {
  bbox: BBox;
  year: FieldsYear;
  minConfidence: number;
  selectedAreaKm2: number;
  confidenceAvailable: boolean;
  count: number;
  truncated: boolean;
  excluded: { confidence: number; noConfidence: number };
  totalAreaM2: number;
  fields: GeoJSON.FeatureCollection<
    GeoJSON.Polygon | GeoJSON.MultiPolygon,
    FieldFeature["properties"]
  >;
}

export interface PatternRequestBody {
  bbox: BBox;
  year: FieldsYear;
  minConfidence?: number;
  grouping?: boolean;
}

/** Mirrors PatternResult without importing the server orchestration graph. */
export interface PatternClientResult {
  bbox: BBox;
  year: number;
  minConfidence: number;
  months: string[];
  count: number;
  truncated: boolean;
  grouping: PatternGroupingInfo;
  classes: Record<PatternClass, number>;
  estimatedPu: number;
  fields: Array<{
    id: string;
    cls: PatternClass;
    group: number | null;
    series: number[] | null;
    validMonths: number;
    metrics: PatternMetrics | null;
  }>;
}

export type PatternStage = "fields" | "ndvi" | "analyze";

export interface PatternStreamHandlers {
  signal?: AbortSignal;
  onStage?: (stage: PatternStage) => void;
  onMonth?: (month: { index: number; label: string }) => void;
}

/** One NDJSON frame from /api/fields/pattern (stage / month / result / error). */
export type PatternFrame =
  | { type: "stage"; stage: PatternStage }
  | { type: "month"; index: number; label: string }
  | { type: "result" } & PatternClientResult
  | { type: "error"; code: string; message: string };

/**
 * Applies one frame; returns the result payload when the stream completes.
 * Throws FieldsClientError on an error frame (mid-stream contract).
 */
export function consumePatternLine(
  raw: string,
  handlers: Pick<PatternStreamHandlers, "onStage" | "onMonth">,
): PatternClientResult | null {
  const frame = JSON.parse(raw) as PatternFrame;
  if (frame.type === "stage") {
    handlers.onStage?.(frame.stage);
    return null;
  }
  if (frame.type === "month") {
    handlers.onMonth?.({ index: frame.index, label: frame.label });
    return null;
  }
  if (frame.type === "error") {
    throw new FieldsClientError(frame.code, frame.message);
  }
  // result frame — strip only the discriminator
  const result: PatternClientResult = { ...frame };
  delete (result as { type?: string }).type;
  return result;
}

async function readError(response: Response): Promise<FieldsClientError> {
  const payload = (await response.json().catch(() => null)) as
    | { code?: string; message?: string }
    | null;
  return new FieldsClientError(
    payload?.code ?? `HTTP_${response.status}`,
    payload?.message ?? "Fields request failed. Try again shortly.",
    response.status,
  );
}

/** POST /api/fields — plain JSON body. */
export async function fetchFields(
  body: FieldsRequestBody,
  signal?: AbortSignal,
): Promise<FieldsResponse> {
  const response = await fetch("/api/fields", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as FieldsResponse;
}

/**
 * POST /api/fields/pattern — consumes the NDJSON progress stream.
 * Pre-stream failures (validation, rate limit, mock mode) answer as JSON and
 * become FieldsClientError; mid-stream failures arrive as an error frame.
 */
export async function streamPattern(
  body: PatternRequestBody,
  handlers: PatternStreamHandlers = {},
): Promise<PatternClientResult> {
  const response = await fetch("/api/fields/pattern", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !contentType.includes("ndjson")) {
    throw await readError(response);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new FieldsClientError("NO_STREAM", "The pattern stream is unavailable in this browser.");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let result: PatternClientResult | null = null;

  const consume = (line: string): void => {
    const parsed = consumePatternLine(line, handlers);
    if (parsed) result = parsed;
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) consume(line);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) consume(buffer.trim());

  if (!result) {
    throw new FieldsClientError(
      "EMPTY_STREAM",
      "The pattern analysis ended without a result.",
    );
  }
  return result;
}

/** Re-exported for panel imports that already pull from the client module. */
export type { PatternMonth };
