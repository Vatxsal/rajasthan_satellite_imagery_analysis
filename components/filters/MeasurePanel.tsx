"use client";

import { Ruler } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";

export default function MeasurePanel() {
  const measureActive = useAppStore((s) => s.measureActive);
  const toggleMeasure = useAppStore((s) => s.toggleMeasure);

  return (
    <div className="space-y-5 p-3">
      <section className="flex items-center justify-between gap-3 rounded border border-border bg-surface-2 p-3">
        <div className="flex items-center gap-2">
          <Ruler size={15} className={measureActive ? "text-accent" : "text-muted"} />
          <div>
            <p className="text-sm font-medium text-text">Measure tool</p>
            <p className="text-xs text-muted">Straight-line distance</p>
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={measureActive}
          onClick={toggleMeasure}
          className={`inline-flex h-6 w-11 shrink-0 items-center rounded-full border px-0.5 transition-colors duration-150 ${
            measureActive ? "border-accent bg-accent-soft" : "border-border bg-surface"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full transition-transform duration-150 ${
              measureActive ? "translate-x-5 bg-accent" : "translate-x-0 bg-muted"
            }`}
          />
        </button>
      </section>

      <section className="space-y-2">
        <h3 className="section-label">Measured segments</h3>
        <p className="rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
          No segments yet
        </p>
      </section>
    </div>
  );
}
