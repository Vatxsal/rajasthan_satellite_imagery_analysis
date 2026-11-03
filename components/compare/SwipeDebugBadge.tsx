"use client";

import { useEffect, useState } from "react";
import {
  getTileTally,
  installTileDebug,
  resetTileTally,
  subscribeTileDebug,
  type TileTally,
} from "@/lib/compare/tileDebug";

/**
 * Dev-only chip over the swipe maps: per-date tile fetch counts
 * (ok / skipped / 429 / failed) so a rate-limited or blue-washed run is
 * visible immediately. Click resets the tally. Never rendered in production.
 */
export default function SwipeDebugBadge() {
  const [tally, setTally] = useState<TileTally>({});

  useEffect(() => {
    installTileDebug();
    setTally(getTileTally());
    return subscribeTileDebug(() => setTally(getTileTally()));
  }, []);

  if (process.env.NODE_ENV !== "development") return null;

  const dates = Object.keys(tally).sort();
  if (dates.length === 0) return null;

  const summary = dates
    .map((date) => {
      const c = tally[date];
      const parts = [`${c.ok} ok`];
      if (c.skip) parts.push(`${c.skip} skip`);
      if (c.limited) parts.push(`${c.limited} ×429`);
      if (c.fail) parts.push(`${c.fail} fail`);
      return `${date.slice(5)} ${parts.join(" ")}`;
    })
    .join(" · ");

  return (
    <button
      type="button"
      onClick={resetTileTally}
      title="Tile fetch counts for the swipe maps (click to reset) — dev only"
      className="mono-nums pointer-events-auto cursor-pointer rounded border border-border bg-surface/90 px-1.5 py-0.5 text-left text-[10px] leading-tight text-muted shadow-float hover:text-text"
    >
      tiles {summary}
    </button>
  );
}
