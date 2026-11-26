import { NextResponse } from "next/server";
import {
  apiError,
  errorResponse,
  rateLimitGuard,
  readJsonBody,
  sameOriginGuard,
} from "@/lib/server/api";
import { authorize, consumeRoleQuota, forbiddenRoleResponse } from "@/lib/auth/guard";
import { bumpGlobalCounter } from "@/lib/auth/quota";
import { can, clampCompareTuning } from "@/lib/auth/permissions";
import { dataSource } from "@/lib/env";
import {
  compareParamsQueryString,
  compareParamsSchema,
  ensureCompare,
  resolveCompareParams,
  validateScenes,
  MOCK_SOURCE_MESSAGE,
} from "@/lib/server/compareRun";
import { ensureDetail } from "@/lib/server/detailRun";
import { ANALYZE_EVENTS_CAP } from "@/lib/analysis/events";
import { compareResultCache, detailResultCache } from "@/lib/cache";

export const runtime = "nodejs";
// Detailed runs stream for as long as the block loop needs (self-hosted
// Node does not enforce this; the quick path finishes far earlier).
export const maxDuration = 300;

/**
 * POST /api/compare/analyze
 *
 * Body: { areaId, level, dateA, dateB, sensitivity?, minPatchHa?,
 *         inputMode?, compositeWindowDays?, detail?, confirm? } (input mode
 *         only applies when CHANGE_ENGINE=v2; detail = Phase 3).
 * Streams newline-delimited JSON:
 *   {"type":"stage","stage":"fetch-a"|"fetch-b"|"rescue"|"analyze"|"screen"}
 *   {"type":"stage","stage":"block","index","total"}   (detailed/smart runs)
 *   {"type":"result","key","overlayUrl","aiEnabled","stats","events",
 *    "detail"?{mode,blocks,blocksTotal,tiles}}          (final)
 *   {"type":"error","code","message"}                        (mid-stream failure)
 * Validation/auth/scene failures return normal { status, code, message }
 * errors before the stream starts (so the first run still fails fast).
 * The result frame ships the first ANALYZE_EVENTS_CAP events inline — the
 * Events tab/list and map markers read them from this frame, no follow-up
 * fetch needed.
 *
 * Phase 3: detail=detailed|smart runs the block orchestrator (SSO-only,
 * consumes the daily detailed quota, needs the client's cost confirmation —
 * the estimate route warms the screening cache first) and reports per-block
 * progress; a client disconnect aborts between blocks.
 */
export async function POST(request: Request): Promise<Response> {
  const originGuard = sameOriginGuard(request);
  if (originGuard) return originGuard;
  const guard = rateLimitGuard(request, "compare");
  if (guard) return guard;

  const auth = await authorize(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const body = await readJsonBody(request, (raw) => compareParamsSchema.parse(raw));

    // Level gate: guests compare at tehsil/ILR only (raw requests included).
    if (body.level === "district" && !can(auth.role, "compare.district")) {
      return forbiddenRoleResponse("compare.district");
    }

    // Phase 3: detailed/smart are SSO-gated and need the cost confirmation
    // (the estimate card runs the screening first — it stays cached).
    const detail = body.detail !== "quick";
    if (detail) {
      if (!can(auth.role, "compare.detailed")) return forbiddenRoleResponse("compare.detailed");
      if (!body.confirm) {
        throw apiError(
          400,
          "DETAIL_CONFIRM_REQUIRED",
          "Confirm the estimated cost before starting a detailed comparison.",
        );
      }
    }

    // Tuning clamp: roles without adjust capabilities run the defaults; the
    // clamp happens before key derivation so every recompute path agrees.
    const tuned = clampCompareTuning(auth.role, body);

    // Daily analysis quota (per session AND per IP, UTC day) — consumed after
    // validation so a malformed body never burns a unit. Detail runs burn the
    // scarcer detailed quota on top.
    const quotaDenied = consumeRoleQuota(auth, "compare");
    if (quotaDenied) return quotaDenied;
    if (detail) {
      const detailDenied = consumeRoleQuota(auth, "detailed");
      if (detailDenied) return detailDenied;
    }

    if (dataSource === "mock") {
      throw apiError(400, "CDSE_CONFIG", MOCK_SOURCE_MESSAGE);
    }

    const resolved = resolveCompareParams(tuned, { role: auth.role });

    // Cache hit → skip the catalogue entirely (strictly faster than before);
    // miss → validate scenes pre-stream so COMPARE_NO_SCENE stays an HTTP
    // error and the CDSE token warms before we open the stream.
    const preCached = detail
      ? detailResultCache.get(resolved.key)
      : compareResultCache.get(resolved.key);
    const sceneHits = preCached ? undefined : await validateScenes(resolved);

    const aiEnabled = resolved.aiEnabled;
    const key = resolved.key;
    const encoder = new TextEncoder();
    const abort = new AbortController();
    request.signal?.addEventListener("abort", () => abort.abort());
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (frame: unknown): void => {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        };
        try {
          const { entry, hit } = detail
            ? await ensureDetail(resolved, {
                onProgress: (progress) =>
                  send(
                    progress.stage === "block"
                      ? {
                          type: "stage",
                          stage: "block",
                          index: progress.index,
                          total: progress.total,
                        }
                      : { type: "stage", stage: progress.stage },
                  ),
                sceneHits,
                signal: abort.signal,
              })
            : await ensureCompare(resolved, {
                onStage: (stage) => send({ type: "stage", stage }),
                sceneHits,
              });
          // Phase 0: full diagnostics object in the dev server log (SSO users
          // see the same numbers in the Method & settings card).
          if (process.env.NODE_ENV === "development" && entry.stats.metadata.diagnostics) {
            console.info(
              `[compare:diagnostics] ${resolved.area.name} (${resolved.area.id}) ` +
                `${resolved.dateA} → ${resolved.dateB} · ${resolved.sensitivity}`,
              JSON.stringify(entry.stats.metadata.diagnostics),
            );
          }
          if (hit) {
            if (detail) {
              send({ type: "stage", stage: "analyze" });
            } else {
              send({ type: "stage", stage: "fetch-a" });
              send({ type: "stage", stage: "fetch-b" });
              send({ type: "stage", stage: "analyze" });
            }
          }
          send({
            type: "result",
            key,
            // Parameters embedded → the overlay image source and every export
            // can rebuild the artifact after a server restart (no 404s).
            overlayUrl: `/api/compare/overlay?key=${key}&${compareParamsQueryString(resolved)}`,
            aiEnabled,
            stats: entry.stats,
            events: entry.events.features.slice(0, ANALYZE_EVENTS_CAP),
            ...(entry.detail
              ? {
                  detail: {
                    mode: entry.detail.mode,
                    blocks: entry.detail.blocks.length,
                    blocksTotal: entry.detail.blocksTotal,
                    tiles: `/api/compare/tiles/{z}/{x}/{y}?key=${key}&${compareParamsQueryString(resolved)}`,
                  },
                }
              : {}),
          });
          bumpGlobalCounter("analyze");
          controller.close();
        } catch (error) {
          console.error("[compare:analyze] failed:", error instanceof Error ? `${error.name}: ${error.message}` : error);
          try {
            send({ type: "error", ...streamErrorBody(error) });
            controller.close();
          } catch {
            // client disconnected — nothing left to do
          }
        }
      },
      cancel() {
        // Client disconnect (cancel/abort): stop the block loop between blocks.
        abort.abort();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Maps mid-stream failures to the { code, message } contract (no HTTP status once streaming). */
function streamErrorBody(error: unknown): { code: string; message: string } {
  const err = error as { code?: unknown; message?: unknown };
  if (err && typeof err.code === "string") {
    return { code: err.code, message: typeof err.message === "string" ? err.message : "Analysis failed." };
  }
  if (error instanceof Error && error.message.startsWith("Invalid environment configuration")) {
    return { code: "CDSE_CONFIG", message: error.message };
  }
  return { code: "UPSTREAM_ERROR", message: "Imagery service request failed. Try again shortly." };
}
