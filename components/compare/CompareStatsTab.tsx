"use client";

import { AlertTriangle, FileJson, Info, Loader2 } from "lucide-react";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import Slider from "@/components/ui/Slider";
import { cn } from "@/components/ui/cn";
import { focusHotspot, focusTehsil } from "@/lib/compare/bridge";
import { downloadHotspotsGeoJson, downloadStatsCsv } from "@/lib/compare/export";
import type { CompareStats } from "@/lib/analysis/types";
import type { Sensitivity } from "@/lib/analysis/config";
import { classColor } from "@/lib/analysis/config";
import { useCompareStore } from "@/store/useCompareStore";

const THRESHOLD_LABELS: Record<string, string> = {
  waterGainDMndwi: "ΔMNDWI water gain ≥",
  waterLossDMndwi: "ΔMNDWI water loss ≤",
  vegLossDNdvi: "ΔNDVI vegetation loss ≤",
  vegGainDNdvi: "ΔNDVI vegetation gain ≥",
  bareBuiltDNdbi: "ΔNDBI bare / built ≥",
  bareBuiltDNdviMax: "ΔNDVI max (bare / built) ≤",
};

function ha(value: number): string {
  return `${value.toLocaleString("en", { maximumFractionDigits: 1 })} ha`;
}

function rgb(color: [number, number, number]): string {
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
      <p className="text-[11px] text-muted">{label}</p>
      <p className="mono-nums text-sm font-medium text-text">{value}</p>
      {hint && <p className="mono-nums text-[10px] text-muted">{hint}</p>}
    </div>
  );
}

interface CompareStatsTabProps {
  tab: "statistics" | "hotspots";
}

/** Statistics + hotspots tabs (the drawer renders this for both). */
export default function CompareStatsTab({ tab }: CompareStatsTabProps) {
  const result = useCompareStore((s) => s.result);
  const sensitivity = useCompareStore((s) => s.sensitivity);
  const minPatchHa = useCompareStore((s) => s.minPatchHa);
  const setSensitivity = useCompareStore((s) => s.setSensitivity);
  const setMinPatchHa = useCompareStore((s) => s.setMinPatchHa);
  const running = useCompareStore((s) => s.running);
  const stage = useCompareStore((s) => s.stage);
  const run = useCompareStore((s) => s.run);
  const choropleth = useCompareStore((s) => s.choropleth);
  const toggleChoropleth = useCompareStore((s) => s.toggleChoropleth);
  const tehsilHighlight = useCompareStore((s) => s.tehsilHighlight);
  const setTehsilHighlight = useCompareStore((s) => s.setTehsilHighlight);
  const hoveredHotspot = useCompareStore((s) => s.hoveredHotspot);
  const setHoveredHotspot = useCompareStore((s) => s.setHoveredHotspot);
  const selectedHotspot = useCompareStore((s) => s.selectedHotspot);

  if (!result) return null;
  const stats: CompareStats = result.stats;
  const { metadata } = stats;
  const lowValid = stats.validPct < 70;
  const stale =
    metadata.sensitivity !== sensitivity || Math.abs(metadata.minPatchHa - minPatchHa) > 1e-9;

  if (tab === "hotspots") {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted">
            Largest surviving change patches — click one to zoom the map.
          </p>
          <Button
            size="sm"
            disabled={stats.hotspots.length === 0}
            onClick={() => downloadHotspotsGeoJson(stats)}
          >
            <FileJson size={13} />
            GeoJSON
          </Button>
        </div>

        {stats.hotspots.length === 0 && (
          <p className="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
            No hotspots — no change patch survived the thresholds and minimum patch size.
          </p>
        )}

        <ol className="flex flex-col gap-1">
          {stats.hotspots.map((hotspot, index) => {
            const color = classColor(hotspot.classCode);
            const rank = index + 1;
            const selected = selectedHotspot === rank;
            // Map-driven hover (marker/polygon mouseenter) highlights the row too.
            const hovered = hoveredHotspot === rank;
            return (
              <li key={`${hotspot.centroid[0]}-${hotspot.centroid[1]}-${index}`}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onMouseEnter={() => setHoveredHotspot(rank)}
                  onMouseLeave={() => setHoveredHotspot(null)}
                  onFocus={() => setHoveredHotspot(rank)}
                  onBlur={() => setHoveredHotspot(null)}
                  onClick={() => focusHotspot(rank, hotspot.bbox)}
                  title="Zoom to this patch and open its map popup"
                  className={cn(
                    "flex w-full items-center gap-2 rounded border bg-surface px-2 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2",
                    selected ? "border-accent" : hovered ? "border-accent/50 bg-surface-2" : "border-border",
                  )}
                >
                  <span className="mono-nums w-4 shrink-0 text-[11px] text-muted">{rank}</span>
                  <span
                    className="h-3 w-3 shrink-0 rounded-sm border border-border"
                    style={{ background: rgb(color) }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-text">
                    {hotspot.classLabel}
                    {hotspot.tehsilName ? ` · ${hotspot.tehsilName}` : ""}
                  </span>
                  <span className="mono-nums shrink-0 text-[11px] text-muted">
                    {hotspot.areaHa.toLocaleString("en", { maximumFractionDigits: 1 })} ha
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {lowValid && (
        <p className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs text-text">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden />
          Only {stats.validPct.toFixed(0)}% of the area has usable data (cloud / no-data masking) —
          treat the totals as a partial picture.
        </p>
      )}
      {stats.negligible && (
        <p className="flex items-start gap-2 rounded border border-border bg-surface-2 px-2.5 py-2 text-xs text-text">
          <Info size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          No significant change survived the thresholds and minimum patch size for this pair. Try
          High sensitivity or a smaller minimum patch below.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Changed area" value={ha(stats.changedHa)} hint={`${(stats.changedHa / 100).toFixed(2)} km²`} />
        <Metric label="Valid data" value={`${stats.validPct.toFixed(1)}%`} />
        <Metric label="Analysed area" value={ha(stats.areaHa)} hint={`valid ${ha(stats.validHa)}`} />
        <Metric label="Date gap" value={`${metadata.gapDays} d`} hint={`${metadata.dateA} → ${metadata.dateB}`} />
      </div>

      {/* ---------------------------------------------------- class breakdown */}
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-surface-2 text-left text-[11px] text-muted">
              <th className="px-2 py-1.5 font-medium">Class</th>
              <th className="px-2 py-1.5 text-right font-medium">Area</th>
              <th className="px-2 py-1.5 text-right font-medium">km²</th>
              <th className="px-2 py-1.5 text-right font-medium">% of valid</th>
            </tr>
          </thead>
          <tbody>
            {stats.classes.map((cls) => (
              <tr key={cls.code} className="border-b border-border last:border-0">
                <td className="px-2 py-1.5">
                  <span className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm border border-border"
                      style={{ background: rgb(cls.color) }}
                      aria-hidden
                    />
                    {cls.label}
                  </span>
                </td>
                <td className="mono-nums px-2 py-1.5 text-right">{ha(cls.areaHa)}</td>
                <td className="mono-nums px-2 py-1.5 text-right">{cls.areaKm2.toFixed(2)}</td>
                <td className="mono-nums px-2 py-1.5 text-right">{cls.pctOfValid.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------------------------------------------------- per-tehsil */}
      {stats.tehsils && stats.tehsils.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] text-muted">
              Click a tehsil to highlight it on the map.
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={choropleth}
              onClick={toggleChoropleth}
              className={cn(
                "inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-[11px] transition-colors duration-150",
                choropleth ? "bg-surface-2 text-text" : "bg-surface text-muted hover:text-text",
              )}
              title="Shade every tehsil by changed area (alpha ∝ √changed)."
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-sm border border-border"
                style={{ background: "rgba(37, 99, 235, 0.45)" }}
              />
              Tehsil shading
            </button>
          </div>
          <div className="overflow-x-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-surface-2 text-left text-[11px] text-muted">
                  <th className="px-2 py-1.5 font-medium">Tehsil</th>
                  <th className="px-2 py-1.5 text-right font-medium">Changed</th>
                  <th className="px-2 py-1.5 font-medium">Dominant change</th>
                </tr>
              </thead>
              <tbody>
                {stats.tehsils.map((row) => {
                  let bestCode = -1;
                  let bestPixels = 0;
                  for (const key of Object.keys(row.pixelsByClass)) {
                    const code = Number(key);
                    const pixels = row.pixelsByClass[code] ?? 0;
                    if (code > 0 && code < 6 && pixels > bestPixels) {
                      bestPixels = pixels;
                      bestCode = code;
                    }
                  }
                  const dominant =
                    bestCode >= 0 && bestPixels > 0
                      ? stats.classes.find((cls) => cls.code === bestCode)?.label ?? "—"
                      : "—";
                  const highlighted = tehsilHighlight?.id === row.tehsilId;
                  return (
                    <tr
                      key={row.tehsilId}
                      onClick={() => {
                        if (highlighted) {
                          setTehsilHighlight(null);
                          return;
                        }
                        setTehsilHighlight({ id: row.tehsilId, name: row.name });
                        focusTehsil(row.tehsilId);
                      }}
                      className={cn(
                        "cursor-pointer border-b border-border transition-colors duration-150 last:border-0 hover:bg-surface-2",
                        highlighted && "bg-accent-soft",
                      )}
                      aria-selected={highlighted}
                      title={highlighted ? "Clear highlight" : "Highlight this tehsil on the map"}
                    >
                      <td className="px-2 py-1.5 text-text">{row.name}</td>
                      <td className="mono-nums px-2 py-1.5 text-right">{ha(row.changedHa)}</td>
                      <td className="px-2 py-1.5 text-muted">{dominant}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ---------------------------------------------------- method + settings */}
      <div className="rounded border border-border bg-surface-2 p-2.5">
        <p className="mb-2 text-xs font-medium text-text">Method &amp; settings</p>
        <dl className="mb-3 grid grid-cols-1 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Resolution</dt>
            <dd className="mono-nums text-text">
              {metadata.metersPerPixel.toFixed(1)} m/px{metadata.coarse ? " (coarse)" : ""}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Grid</dt>
            <dd className="mono-nums text-text">
              {metadata.width}×{metadata.height} px
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Scene A</dt>
            <dd className="mono-nums text-text">
              {metadata.sceneA
                ? `${metadata.sceneA.satellite} · ${metadata.sceneA.cloudCover.toFixed(0)}% cloud`
                : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted">Scene B</dt>
            <dd className="mono-nums text-text">
              {metadata.sceneB
                ? `${metadata.sceneB.satellite} · ${metadata.sceneB.cloudCover.toFixed(0)}% cloud`
                : "—"}
            </dd>
          </div>
          {Object.entries(metadata.thresholds).map(([key, value]) => (
            <div key={key} className="flex justify-between gap-2">
              <dt className="text-muted">{THRESHOLD_LABELS[key] ?? key}</dt>
              <dd className="mono-nums text-text">{value.toFixed(2)}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <p className="mb-1 text-[11px] text-muted">
              Sensitivity — low = fewer, stronger changes
            </p>
            <Segmented
              ariaLabel="Change detection sensitivity"
              value={sensitivity}
              onChange={(value) => setSensitivity(value as Sensitivity)}
              options={[
                { value: "low", label: "Low" },
                { value: "medium", label: "Medium" },
                { value: "high", label: "High" },
              ]}
            />
          </div>
          <div className="flex-1">
            <p className="mb-1 flex items-center justify-between text-[11px] text-muted">
              Minimum patch
              <span className="mono-nums text-text">{minPatchHa.toFixed(2)} ha</span>
            </p>
            <Slider
              aria-label="Minimum patch size in hectares"
              min={0.01}
              max={10}
              step={0.01}
              value={minPatchHa}
              onChange={(event) => setMinPatchHa(Number(event.target.value))}
            />
          </div>
          <Button
            variant={stale ? "primary" : "secondary"}
            disabled={running}
            className="shrink-0"
            title="Runs the analysis again with the current settings (new result)."
            onClick={() => void run()}
          >
            {running && stage ? "Working…" : stale ? "Re-run with settings" : "Re-run"}
          </Button>
        </div>
        {running && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 size={12} className="animate-spin" aria-hidden />
            Re-running the analysis…
          </p>
        )}
      </div>

      {/* ---------------------------------------------------- exports */}
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted">Generated {new Date(metadata.generatedAt).toLocaleString()}</p>
        <Button size="sm" onClick={() => downloadStatsCsv(stats)}>
          Export CSV
        </Button>
      </div>

      <p className="text-[10px] leading-relaxed text-muted">
        Plain-language explanations moved to the <span className="text-text">Summary</span> tab.
      </p>
    </div>
  );
}
