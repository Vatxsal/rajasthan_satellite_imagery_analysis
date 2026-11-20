/**
 * Draw & analyze — server-side shape limits from the DRAW_MAX_* env
 * (Phase 5). The client keeps the lib/draw/constants defaults for live HUD
 * feedback; every server rule check (validate / analyze / export) passes
 * this object so a deployment can tighten or loosen the ceilings without a
 * code change. Server values are authoritative.
 */
import { getServerEnv } from "@/lib/env";
import type { DrawLimits } from "@/lib/draw/geometry";

export function serverDrawLimits(): DrawLimits {
  const env = getServerEnv();
  return {
    maxKm2: env.DRAW_MAX_KM2,
    maxBboxKm: env.DRAW_MAX_BBOX_KM,
    maxVertices: env.DRAW_MAX_VERTICES,
  };
}
