"use client";

import { useActiveScene, useAppStore } from "@/store/useAppStore";
import { cn } from "@/components/ui/cn";
import { BandNote, NdviColorBar } from "@/components/map/CompositeLegend";

interface LineSwatchProps {
  color: string;
  width: number;
  dash?: "solid" | "dashed" | "dotted";
  className?: string;
}

export function LineSwatch({ color, width, dash = "solid", className }: LineSwatchProps) {
  return (
    <span className={cn("relative block h-3 w-8", className)} aria-hidden>
      <span
        className="absolute left-0 top-1/2 w-full -translate-y-1/2"
        style={{
          borderTopWidth: `${width}px`,
          borderTopColor: color,
          borderTopStyle: dash,
        }}
      />
    </span>
  );
}

interface LegendEntry {
  key: string;
  label: string;
  swatch: React.ReactNode;
}

export function useLegendEntries(): LegendEntry[] {
  return [
    {
      key: "selection",
      label: "Selected area",
      swatch: (
        <span
          className="block h-3 w-8 rounded-sm"
          style={{ border: "2px solid var(--accent)", background: "rgb(var(--accent) / 0.1)" }}
        />
      ),
    },
    {
      key: "districts",
      label: "District",
      swatch: <LineSwatch color="var(--text)" width={1.5} />,
    },
    {
      key: "tehsils",
      label: "Tehsil",
      swatch: <LineSwatch color="var(--text)" width={1} dash="dashed" />,
    },
    {
      key: "ilrs",
      label: "ILR",
      swatch: <LineSwatch color="var(--text-muted)" width={1} dash="dotted" />,
    },
    {
      key: "imagery",
      label: "Imagery overlay",
      swatch: (
        <span
          className="block h-3 w-8 rounded-sm border border-border"
          style={{ background: "#B7B1A3" }}
        />
      ),
    },
  ];
}

export default function Legend({ className }: { className?: string }) {
  const entries = useLegendEntries();
  const activeScene = useActiveScene();
  const storeComposite = useAppStore((s) => s.composite);
  const composite = activeScene?.composite ?? storeComposite;

  return (
    <div className={className}>
      <ul className="space-y-1.5">
        {entries.map((entry) => (
          <li key={entry.key} className="flex items-center gap-2.5">
            {entry.swatch}
            <span className="text-xs text-text">{entry.label}</span>
          </li>
        ))}
      </ul>
      {/* Composite-specific legend: NDVI ramp or band note (EO Browser style). */}
      <div className="mt-2.5 border-t border-border pt-2.5">
        <p className="section-label mb-1.5">Imagery composite</p>
        {composite === "ndvi" ? (
          <NdviColorBar />
        ) : (
          <BandNote composite={composite} />
        )}
      </div>
    </div>
  );
}
