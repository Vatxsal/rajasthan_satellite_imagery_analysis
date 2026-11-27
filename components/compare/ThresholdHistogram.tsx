"use client";

import { useCallback, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";

/**
 * Phase-thresholds: one Δ-index histogram (about 200 bins from the analysis
 * result) with draggable threshold markers. Pure browser math — the counts
 * ("N px, X% of analysed pixels beyond this threshold") and the likely-noise
 * warning (share above ~5%) recompute locally on every drag; nothing is sent
 * until the user presses Re-run.
 */

export interface HistogramMarker {
  /** Override field id (vegLossD, …) — routed back through onChange. */
  id: string;
  /** Current value (index units). */
  value: number;
  /** Drag clamp range (THRESHOLD_BOUNDS entry). */
  min: number;
  max: number;
  /** Short label shown at the marker. */
  label: string;
  /** Which tail counts as "beyond the threshold". */
  direction: "above" | "below";
  /** Marker colour (CSS). */
  color: string;
}

interface DeltaHistogramShape {
  bins: number[];
  min: number;
  max: number;
  binCount: number;
}

/** A share of analysed pixels beyond this flag triggers the noise warning. */
export const LIKELY_NOISE_SHARE = 0.05;

function countBeyond(
  histogram: DeltaHistogramShape,
  value: number,
  direction: "above" | "below",
): { count: number; total: number } {
  let count = 0;
  let total = 0;
  const span = histogram.max - histogram.min;
  for (let b = 0; b < histogram.bins.length; b++) {
    const n = histogram.bins[b];
    total += n;
    if (n === 0) continue;
    // Bin centre — the honest midpoint of the clamped bucket.
    const center = histogram.min + ((b + 0.5) / histogram.binCount) * span;
    if (direction === "above" ? center >= value : center <= value) count += n;
  }
  return { count, total };
}

export default function ThresholdHistogram({
  histogram,
  unit,
  markers,
  onChange,
  disabled = false,
}: {
  histogram: DeltaHistogramShape;
  /** Axis label, e.g. "ΔNDVI". */
  unit: string;
  markers: HistogramMarker[];
  /** Live drag/numeric updates (values only apply on Re-run). */
  onChange: (id: string, value: number) => void;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const span = histogram.max - histogram.min;
  const xOf = (value: number): number => ((value - histogram.min) / span) * 100;

  const valueFromPointer = useCallback(
    (clientX: number, marker: HistogramMarker): number => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return marker.value;
      const t = (clientX - rect.left) / rect.width;
      const raw = histogram.min + t * span;
      const clamped = Math.min(marker.max, Math.max(marker.min, raw));
      // One-hundredth index units — the sliders' step.
      return Math.round(clamped * 100) / 100;
    },
    [histogram.min, span],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      if (!dragId) return;
      const marker = markers.find((m) => m.id === dragId);
      if (!marker) return;
      onChange(marker.id, valueFromPointer(event.clientX, marker));
    },
    [dragId, markers, onChange, valueFromPointer],
  );

  const stopDrag = useCallback(() => {
    if (!dragId) return;
    setDragId(null);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
  }, [dragId, onPointerMove]);

  const startDrag = (marker: HistogramMarker) => (event: React.PointerEvent) => {
    if (disabled) return;
    event.preventDefault();
    setDragId(marker.id);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
  };

  const peak = Math.max(1, ...histogram.bins);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-medium text-text">{unit}</p>
        <p className="text-[10px] text-muted">
          analysed pixels: {histogram.bins.reduce((sum, n) => sum + n, 0).toLocaleString()}
        </p>
      </div>
      <div
        ref={trackRef}
        className={cn(
          "relative h-14 w-full touch-none select-none rounded-sm border border-border bg-surface-2",
          disabled && "pointer-events-none opacity-60",
        )}
        role="img"
        aria-label={`${unit} histogram with draggable thresholds`}
      >
        {/* bins */}
        <div className="absolute inset-0 flex items-end px-0">
          {histogram.bins.map((count, index) => (
            <div
              key={index}
              aria-hidden
              className="h-full flex-1 bg-border/70"
              style={{ height: `${Math.max(count > 0 ? 2 : 0, (count / peak) * 100)}%`, opacity: 0.55 }}
            />
          ))}
        </div>
        {/* markers */}
        {markers.map((marker) => {
          const { count, total } = countBeyond(histogram, marker.value, marker.direction);
          const share = total > 0 ? count / total : 0;
          const noisy = share > LIKELY_NOISE_SHARE;
          return (
            <div key={marker.id}>
              <div
                aria-hidden
                className="absolute inset-y-0 w-px"
                style={{ left: `${xOf(marker.value)}%`, background: marker.color }}
              />
              <button
                type="button"
                aria-label={`${marker.label} threshold ${marker.value.toFixed(2)} — drag to adjust`}
                onPointerDown={startDrag(marker)}
                onKeyDown={(event) => {
                  if (disabled) return;
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    const step = event.key === "ArrowLeft" ? -0.01 : 0.01;
                    const next = Math.min(marker.max, Math.max(marker.min, marker.value + step));
                    onChange(marker.id, Math.round(next * 100) / 100);
                  }
                }}
                className="absolute top-0.5 z-10 -translate-x-1/2 rounded-sm border border-border px-1 py-px text-[9px] font-medium text-text shadow-sm"
                style={{ left: `${xOf(marker.value)}%`, background: marker.color }}
              >
                {marker.value.toFixed(2)}
              </button>
              <p
                className={cn(
                  "absolute -bottom-0.5 z-10 -translate-x-1/2 whitespace-nowrap rounded-sm px-1 text-[9px] leading-tight",
                  noisy ? "bg-warning/15 text-warning" : "text-muted",
                )}
                style={{ left: `${xOf(marker.value)}%` }}
                title={
                  noisy
                    ? "Beyond-threshold share is unusually large — this setting is likely catching noise."
                    : undefined
                }
              >
                {noisy ? "⚠ " : ""}
                {(share * 100).toFixed(share < 0.095 ? 1 : 0)}%
              </p>
            </div>
          );
        })}
      </div>
      {/* per-rule live counts */}
      <ul className="flex flex-col gap-0.5">
        {markers.map((marker) => {
          const { count, total } = countBeyond(histogram, marker.value, marker.direction);
          const share = total > 0 ? count / total : 0;
          const noisy = share > LIKELY_NOISE_SHARE;
          return (
            <li key={marker.id} className="flex flex-wrap items-baseline justify-between gap-x-2 text-[10px]">
              <span className="min-w-0 truncate text-muted">{marker.label}</span>
              <span className={cn("mono-nums shrink-0", noisy ? "text-warning" : "text-text")}>
                {count.toLocaleString()} px · {(share * 100).toFixed(1)}%
                {noisy ? " — likely noise" : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
