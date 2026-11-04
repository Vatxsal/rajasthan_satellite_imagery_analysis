import { getServerEnv } from "@/lib/env";
import { sharedInstance } from "../singleton";
import { apiError } from "./api";

/**
 * Daily cap on Copernicus Process API renders, counted per UTC day.
 *
 * Best-effort and in-memory: on serverless platforms the counter is local to
 * each warm instance, so the effective global cap is higher — it still stops a
 * single hot instance from burning quota in a runaway loop. Set
 * DAILY_RENDER_BUDGET=0 to disable.
 *
 * The counter itself is a globalThis singleton so dev HMR / per-route module
 * graphs cannot fork it either (lib/singleton.ts).
 */
const budget = sharedInstance("rse.renderBudget", () => ({ currentDay: "", rendersUsed: 0 }));

export function consumeRenderBudget(): void {
  const limit = getServerEnv().DAILY_RENDER_BUDGET;
  if (limit <= 0) return;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== budget.currentDay) {
    budget.currentDay = today;
    budget.rendersUsed = 0;
  }

  if (budget.rendersUsed >= limit) {
    throw apiError(
      429,
      "DAILY_BUDGET_EXCEEDED",
      `Daily imagery budget reached (${limit} renders/day). Resets at 00:00 UTC — raise DAILY_RENDER_BUDGET to allow more.`,
    );
  }
  budget.rendersUsed += 1;
}
