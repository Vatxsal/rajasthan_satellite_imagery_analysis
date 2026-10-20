"use client";

import type { CompositeId } from "@/lib/data";
import { NDVI_RAMP } from "@/lib/cdse/evalscripts";
import { cn } from "@/components/ui/cn";

/**
 * EO Browser-style composite legend: NDVI colour ramp (-0.2 … 0.8) or a
 * one-line band note for True/False colour. The ramp is the exact same
 * NDVI_RAMP the evalscript interpolates, so the bar always matches pixels.
 */

const LEGEND_MIN = -0.2;
const LEGEND_MAX = 0.8;

function rampGradientCss(): string {
  const stops: string[] = [];
  for (const [value, rgb] of NDVI_RAMP) {
    const clamped = Math.max(LEGEND_MIN, Math.min(LEGEND_MAX, value));
    const pct = ((clamped - LEGEND_MIN) / (LEGEND_MAX - LEGEND_MIN)) * 100;
    const [r, g, b] = rgb.map((c) => Math.round(c * 255));
    stops.push(`rgb(${r}, ${g}, ${b}) ${pct.toFixed(1)}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

export function NdviColorBar({ className }: { className?: string }) {
  return (
    <div className={cn("w-40", className)}>
      <div
        aria-hidden
        className="h-2.5 w-full rounded-sm border border-border"
        style={{ background: rampGradientCss() }}
      />
      <div className="mono-nums mt-0.5 flex justify-between text-[10px] text-muted">
        <span>-0.2</span>
        <span className="text-text">NDVI</span>
        <span>0.8</span>
      </div>
    </div>
  );
}

const BAND_NOTES: Record<Exclude<CompositeId, "ndvi">, string> = {
  "true-color": "B4 / B3 / B2 · true colour",
  "false-color": "B8 / B4 / B3 · false colour",
};

export function BandNote({ composite, className }: { composite: CompositeId; className?: string }) {
  if (composite === "ndvi") return <NdviColorBar className={className} />;
  return (
    <p className={cn("mono-nums text-[11px] text-muted", className)}>{BAND_NOTES[composite]}</p>
  );
}

/** Small fixed bar at the map's bottom-right corner while imagery is shown. */
export default function CompositeLegendBar({
  composite,
  className,
  style,
}: {
  composite: CompositeId;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn(
        "rounded border border-border bg-surface/95 px-2 py-1.5 shadow-float backdrop-blur-sm",
        className,
      )}
      style={style}
    >
      {composite === "ndvi" ? (
        <NdviColorBar className="w-36" />
      ) : (
        <p className="mono-nums text-[11px] text-muted">{BAND_NOTES[composite]}</p>
      )}
    </div>
  );
}
