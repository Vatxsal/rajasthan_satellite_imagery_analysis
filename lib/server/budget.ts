import { getServerEnv } from "@/lib/env";
import { apiError } from "./api";

/**
 * Daily cap on Copernicus Process API renders, counted per UTC day.
 *
 * Best-effort and in-memory: on serverless platforms the counter is local to
 * each warm instance, so the effective global cap is higher — it still stops a
 * single hot instance from burning quota in a runaway loop. Set
 * DAILY_RENDER_BUDGET=0 to disable.
 */
let currentDay = "";
let rendersUsed = 0;

export function consumeRenderBudget(): void {
  const limit = getServerEnv().DAILY_RENDER_BUDGET;
  if (limit <= 0) return;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDay) {
    currentDay = today;
    rendersUsed = 0;
  }

  if (rendersUsed >= limit) {
    throw apiError(
      429,
      "DAILY_BUDGET_EXCEEDED",
      `Daily imagery budget reached (${limit} renders/day). Resets at 00:00 UTC — raise DAILY_RENDER_BUDGET to allow more.`,
    );
  }
  rendersUsed += 1;
}
