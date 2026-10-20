"use client";

import { Eye, EyeOff } from "lucide-react";
import type { ReactNode } from "react";
import { useActiveScene, useAppStore } from "@/store/useAppStore";
import Slider from "@/components/ui/Slider";
import { cn } from "@/components/ui/cn";
import Legend from "./Legend";

interface RowProps {
  label: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
  swatch: ReactNode;
  children?: ReactNode;
}

function LayerRow({ label, description, checked, onToggle, swatch, children }: RowProps) {
  return (
    <div
      className={cn(
        "rounded border px-2.5 py-2 transition-colors duration-150",
        checked ? "border-border bg-surface" : "border-border bg-surface-2",
      )}
    >
      <div className="flex items-center gap-2.5">
        {swatch}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text">{label}</p>
          <p className="truncate text-xs text-muted">{description}</p>
        </div>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={checked}
          aria-label={`${checked ? "Hide" : "Show"} ${label}`}
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded transition-colors duration-150",
            checked ? "text-accent hover:bg-accent-soft" : "text-muted hover:bg-surface hover:text-text",
          )}
        >
          {checked ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      </div>
      {children}
    </div>
  );
}

export default function LayersPanel() {
  const adminLayers = useAppStore((s) => s.adminLayers);
  const toggleAdminLayer = useAppStore((s) => s.toggleAdminLayer);
  const imageryVisible = useAppStore((s) => s.imageryVisible);
  const toggleImagery = useAppStore((s) => s.toggleImagery);
  const imageryOpacity = useAppStore((s) => s.imageryOpacity);
  const setImageryOpacity = useAppStore((s) => s.setImageryOpacity);
  const sceneFootprintVisible = useAppStore((s) => s.sceneFootprintVisible);
  const toggleSceneFootprint = useAppStore((s) => s.toggleSceneFootprint);
  const activeScene = useActiveScene();

  return (
    <div className="space-y-6 p-3">
      <section className="space-y-2">
        <h3 className="section-label">Layers</h3>

        <LayerRow
          label="District boundaries"
          description="Solid rule"
          checked={adminLayers.districts}
          onToggle={() => toggleAdminLayer("districts")}
          swatch={
            <span
              aria-hidden
              className="block h-3 w-8"
              style={{ borderTop: "1.5px solid var(--text)" }}
            />
          }
        />
        <LayerRow
          label="Tehsil boundaries"
          description="Dashed rule"
          checked={adminLayers.tehsils}
          onToggle={() => toggleAdminLayer("tehsils")}
          swatch={
            <span
              aria-hidden
              className="block h-3 w-8"
              style={{ borderTop: "1px dashed var(--text)" }}
            />
          }
        />
        <LayerRow
          label="ILR boundaries"
          description="Dotted rule"
          checked={adminLayers.ilrs}
          onToggle={() => toggleAdminLayer("ilrs")}
          swatch={
            <span
              aria-hidden
              className="block h-3 w-8"
              style={{ borderTop: "1px dotted var(--text-muted)" }}
            />
          }
        />
        <LayerRow
          label="Scene footprint"
          description={
            activeScene
              ? `Tile footprint of ${activeScene.date}`
              : "Select a scene to show its footprint"
          }
          checked={sceneFootprintVisible}
          onToggle={toggleSceneFootprint}
          swatch={
            <span
              aria-hidden
              className="block h-3 w-8"
              style={{ borderTop: "1.5px dashed var(--accent)" }}
            />
          }
        />
        <LayerRow
          label="Imagery overlay"
          description="Preview raster"
          checked={imageryVisible}
          onToggle={toggleImagery}
          swatch={
            <span
              aria-hidden
              className="block h-3 w-8 rounded-sm border border-border"
              style={{ background: "#B7B1A3" }}
            />
          }
        >
          <div className="mt-2 flex items-center gap-2 pl-[2.75rem]">
            <Slider
              min={0}
              max={100}
              step={5}
              value={Math.round(imageryOpacity * 100)}
              disabled={!imageryVisible}
              aria-label="Imagery overlay opacity"
              onChange={(event) => setImageryOpacity(Number(event.target.value) / 100)}
            />
            <span className="mono-nums w-9 shrink-0 text-right text-xs text-muted">
              {Math.round(imageryOpacity * 100)}%
            </span>
          </div>
        </LayerRow>
      </section>

      <section className="space-y-2.5">
        <h3 className="section-label">Legend</h3>
        <div className="rounded border border-border bg-surface p-3">
          <Legend />
        </div>
      </section>
    </div>
  );
}
