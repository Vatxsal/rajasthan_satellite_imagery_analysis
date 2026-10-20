"use client";

import { SATELLITE_BASEMAP } from "@/lib/map/constants";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/components/ui/cn";

function MapThumb() {
  // Static light-map preview in the app's neutral palette. SVG presentation
  // attributes don't support var(), so colors are literal tokens.
  return (
    <svg viewBox="0 0 48 32" className="h-full w-full" aria-hidden>
      <rect width="48" height="32" fill="#EFEDE7" />
      {/* park blocks */}
      <rect x="2" y="18" width="10" height="9" rx="1.5" fill="#DDE5D3" />
      <rect x="34" y="2" width="11" height="7" rx="1.5" fill="#DDE5D3" />
      {/* water */}
      <path d="M20 32 C22 24 28 22 34 24 L34 32 Z" fill="#C9D6DE" />
      {/* road grid */}
      <g stroke="#FFFFFF" strokeWidth="2" fill="none" strokeLinecap="round">
        <path d="M0 12 H48" />
        <path d="M16 0 V32" />
      </g>
      <g stroke="#DAD7CF" strokeWidth="0.75" fill="none">
        <path d="M0 22 H48" />
        <path d="M30 0 V32" />
        <path d="M8 0 V32" />
        <path d="M0 6 H48" />
      </g>
      {/* highlighted route */}
      <path d="M4 28 L16 28 L16 12 L38 12" stroke="#C2410C" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function BasemapSwitcher() {
  const basemap = useAppStore((s) => s.basemap);
  const setBasemap = useAppStore((s) => s.setBasemap);

  return (
    <div
      role="group"
      aria-label="Basemap"
      className="flex overflow-hidden rounded border border-border bg-surface shadow-float"
    >
      <button
        type="button"
        aria-pressed={basemap === "streets"}
        onClick={() => setBasemap("streets")}
        title="Map"
        className={cn(
          "flex flex-col items-center gap-1 border-r border-border p-1 transition-colors duration-150",
          basemap === "streets" ? "bg-accent-soft" : "hover:bg-surface-2",
        )}
      >
        <span
          className={cn(
            "block h-8 w-12 overflow-hidden rounded-sm border",
            basemap === "streets" ? "border-accent" : "border-border",
          )}
        >
          <MapThumb />
        </span>
        <span className={cn("text-[11px]", basemap === "streets" ? "font-medium text-accent" : "text-muted")}>
          Map
        </span>
      </button>
      <button
        type="button"
        aria-pressed={basemap === "satellite"}
        onClick={() => setBasemap("satellite")}
        title="Satellite"
        className={cn(
          "flex flex-col items-center gap-1 p-1 transition-colors duration-150",
          basemap === "satellite" ? "bg-accent-soft" : "hover:bg-surface-2",
        )}
      >
        <span
          className={cn(
            "block h-8 w-12 overflow-hidden rounded-sm border",
            basemap === "satellite" ? "border-accent" : "border-border",
          )}
        >
          {/* Real Esri preview tile for the Rajasthan region */}
          {/* eslint-disable-next-line @next/next/no-img-element -- remote basemap thumbnail */}
          <img
            src={SATELLITE_BASEMAP.thumbnail}
            alt=""
            width={48}
            height={32}
            className="h-full w-full object-cover"
          />
        </span>
        <span
          className={cn("text-[11px]", basemap === "satellite" ? "font-medium text-accent" : "text-muted")}
        >
          Satellite
        </span>
      </button>
    </div>
  );
}
