"use client";

import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import Button from "@/components/ui/Button";
import FeatureLock, { useLocked } from "@/components/ui/FeatureLock";
import { DRAW_PALETTE } from "@/lib/draw/constants";
import { measureDrawGeometry, validateDrawGeometry } from "@/lib/draw/geometry";
import { savedShapeId } from "@/lib/draw/saved";
import { formatArea, formatDate, formatLength } from "@/lib/format";
import { useDrawStore, type DrawAnalysis } from "@/store/useDrawStore";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useInspectorStore } from "@/store/useInspectorStore";

interface ShapeCardProps {
  /** Bottom offset from MapCanvas (strip/sheet-aware). */
  style?: React.CSSProperties;
}

/**
 * Card for the selected / just-finished shape: name, note, colour, live
 * validity, the Phase 3 analyze run, Phase 4 save (browser-local) and
 * shapefile download. Delete removes it from the map only — saved copies
 * live in the panel's Saved shapes list until explicitly removed there.
 */
export default function ShapeCard({ style }: ShapeCardProps) {
  const activeShapeId = useDrawStore((s) => s.activeShapeId);
  const shape = useDrawStore((s) => s.shapes.find((item) => item.id === s.activeShapeId) ?? null);
  const rajasthan = useDrawStore((s) => s.rajasthan);
  const closeCard = useDrawStore((s) => s.closeCard);
  const setShapeField = useDrawStore((s) => s.setShapeField);
  const requestDelete = useDrawStore((s) => s.requestDelete);
  const analysis = useDrawStore((s) => s.analysis);
  const runAnalysis = useDrawStore((s) => s.runAnalysis);
  const savedShapes = useDrawStore((s) => s.savedShapes);
  const upsertCurrentShape = useDrawStore((s) => s.upsertCurrentShape);
  const areaUnit = usePreferencesStore((s) => s.values.units.areaUnit);
  // draw.* capability locks (guests hold basic/analyze/save; export is SSO-only).
  const analyzeLocked = useLocked("draw.analyze");
  const saveLocked = useLocked("draw.save");
  const exportLocked = useLocked("draw.export.shapefile");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // The inspector and the shape card are mutually exclusive cards.
  useEffect(() => {
    if (!activeShapeId) return;
    const inspector = useInspectorStore.getState();
    if (inspector.open) inspector.close();
  }, [activeShapeId]);

  if (!activeShapeId || !shape) return null;

  const metrics = measureDrawGeometry(shape.geometry);
  const validity = validateDrawGeometry(shape.geometry, rajasthan);
  const shapeAnalysis = analysis?.shapeId === shape.id ? analysis : null;
  const analyzing = shapeAnalysis?.status === "running";
  const isSaved = savedShapes.some((item) => item.id === savedShapeId(shape.geometry));

  const handleSave = (): void => {
    const outcome = upsertCurrentShape(shape.id);
    setSaveError(
      outcome === "full"
        ? "Saved-shapes list is full (50). Remove one from the panel first."
        : outcome === "invalid"
          ? "Could not save this shape."
          : null,
    );
  };

  const handleDownload = async (): Promise<void> => {
    setExporting(true);
    setExportError(null);
    try {
      const response = await fetch("/api/shapes/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: shape.name, geometry: shape.geometry }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? "Export failed. Try again shortly.");
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "shape.zip";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-label="Drawn shape"
      data-testid="shape-card"
      className="absolute right-3 z-30 flex max-h-[min(70vh,32rem)] w-[19rem] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded border border-border bg-surface shadow-float"
      style={style}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <input
          type="text"
          value={shape.name}
          aria-label="Shape name"
          onChange={(event) => setShapeField(shape.id, { name: event.target.value })}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-text hover:border-border focus:border-accent focus:outline-none"
        />
        <FeatureLock capability="draw.export.shapefile" label="Shapefile download" />
        <Button variant="ghost" size="icon" aria-label="Close shape card" onClick={closeCard}>
          <X size={16} />
        </Button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-2.5">
        <dl className="space-y-1.5 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Area</dt>
            <dd className="mono-nums text-text">
              {metrics ? formatArea(metrics.areaM2 / 10_000, areaUnit) : "—"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Perimeter</dt>
            <dd className="mono-nums text-text">{metrics ? formatLength(metrics.perimeterM) : "—"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Vertices</dt>
            <dd className="mono-nums text-text">{metrics?.vertices ?? "—"}</dd>
          </div>
        </dl>

        <p
          role="status"
          className={`rounded border px-2 py-1.5 text-xs ${
            validity.ok
              ? "border-border bg-surface-2 text-success"
              : validity.kind === "error"
                ? "border-danger/40 bg-danger/10 text-danger"
                : "border-border bg-surface-2 text-muted"
          }`}
        >
          {validity.ok ? "Valid shape" : validity.message}
        </p>

        <label className="block">
          <span className="section-label">Note</span>
          <textarea
            value={shape.note}
            rows={2}
            placeholder="Optional note…"
            aria-label="Shape note"
            onChange={(event) => setShapeField(shape.id, { note: event.target.value })}
            className="mt-1 w-full resize-none rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
        </label>

        <div>
          <span className="section-label">Colour</span>
          <div className="mt-1.5 flex gap-1.5" role="group" aria-label="Shape colour">
            {DRAW_PALETTE.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Colour ${color}`}
                aria-pressed={shape.color === color}
                onClick={() => setShapeField(shape.id, { color })}
                className={`h-6 w-6 rounded-full border-2 transition-transform duration-150 ${
                  shape.color === color ? "scale-110 border-text" : "border-transparent"
                }`}
                style={{ backgroundColor: color }}
              />
            ))}
          </div>
        </div>

        {/* Analyze streams stats; Save keeps a browser-local copy; Download
            exports a shapefile (.shp/.dbf/.prj zip). */}
        <div className="grid grid-cols-3 gap-1.5">
          <Button
            variant="secondary"
            size="sm"
            disabled={!validity.ok || analyzing || analyzeLocked}
            title={
              analyzeLocked
                ? "Available with an SSO ID"
                : validity.ok
                  ? analyzing
                    ? "Analysis running…"
                    : "Statistics for the least-cloudy scene in the search window"
                  : validity.message
            }
            onClick={() => void runAnalysis(shape.id)}
            data-testid="shape-analyze"
          >
            {analyzing ? "Analyzing…" : "Analyze"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!validity.ok || saveLocked}
            title={
              saveLocked
                ? "Available with an SSO ID"
                : validity.ok
                  ? "Save in this browser"
                  : validity.message
            }
            onClick={handleSave}
            data-testid="shape-save"
          >
            {isSaved ? "Saved ✓" : "Save"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!validity.ok || exporting || exportLocked}
            title={
              exportLocked
                ? "Available with an SSO ID"
                : validity.ok
                  ? "Download as shapefile (.zip)"
                  : validity.message
            }
            onClick={() => void handleDownload()}
            data-testid="shape-download"
          >
            {exporting ? "…" : "Download"}
          </Button>
        </div>

        {(saveError || exportError) && (
          <p
            role="alert"
            data-testid="shape-card-error"
            className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger"
          >
            {saveError ?? exportError}
          </p>
        )}

        {shapeAnalysis && <AnalysisBlock analysis={shapeAnalysis} areaUnit={areaUnit} />}
      </div>

      <footer className="shrink-0 border-t border-border px-3 py-2">
        <Button
          variant="danger"
          size="sm"
          className="w-full"
          onClick={() => requestDelete(shape.id)}
          data-testid="shape-delete"
        >
          <Trash2 size={14} />
          Delete shape
        </Button>
      </footer>
    </div>
  );
}

function AnalysisRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="mono-nums text-right text-text">{value}</dd>
    </div>
  );
}

/** Analyze result: progress line, error, or the stats rows of one scene. */
function AnalysisBlock({
  analysis,
  areaUnit,
}: {
  analysis: DrawAnalysis;
  areaUnit: Parameters<typeof formatArea>[1];
}) {
  const dateFormat = usePreferencesStore((s) => s.values.units.dateFormat);

  if (analysis.status === "running") {
    return (
      <p
        role="status"
        className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-muted"
      >
        {analysis.stage === "render"
          ? "Fetching imagery…"
          : analysis.stage === "stats"
            ? "Computing statistics…"
            : "Starting analysis…"}
      </p>
    );
  }
  if (analysis.status === "error") {
    return (
      <p
        role="alert"
        data-testid="shape-analysis"
        className="rounded border border-danger/40 bg-danger/10 px-2 py-1.5 text-xs text-danger"
      >
        {analysis.error}
      </p>
    );
  }

  const result = analysis.result;
  if (!result) return null;
  const { stats, metrics } = result;
  const clearPct =
    stats.pixels.valid > 0 ? (stats.pixels.clear / stats.pixels.valid) * 100 : 0;

  return (
    <div
      data-testid="shape-analysis"
      className="space-y-1.5 rounded border border-border bg-surface-2 px-2 py-1.5"
    >
      <span className="section-label">Analysis</span>
      <dl className="space-y-1 text-xs">
        <AnalysisRow
          label="Scene"
          value={`${formatDate(result.date, dateFormat)} · ${Math.round(result.cloudCover)}% cloud`}
        />
        {stats.ndvi ? (
          <>
            <AnalysisRow
              label="NDVI mean"
              value={`${stats.ndvi.mean.toFixed(2)} · median ${stats.ndvi.median.toFixed(2)}`}
            />
            <AnalysisRow
              label="NDVI range"
              value={`${stats.ndvi.min.toFixed(2)} – ${stats.ndvi.max.toFixed(2)}`}
            />
          </>
        ) : (
          <AnalysisRow label="NDVI" value="No clear pixels" />
        )}
        <AnalysisRow
          label="Clear pixels"
          value={`${clearPct.toFixed(0)}% of ${stats.pixels.valid.toLocaleString()}`}
        />
        {stats.scl && (
          <AnalysisRow
            label="Cover"
            value={`Veg ${stats.scl.vegetation}% · Bare ${stats.scl.bare}% · Water ${stats.scl.water}% · Cloud ${stats.scl.cloud}%`}
          />
        )}
        {metrics && <AnalysisRow label="Area" value={formatArea(metrics.areaM2 / 10_000, areaUnit)} />}
        <AnalysisRow label="Est. cost" value={`${result.pu.toFixed(3)} PU`} />
      </dl>
    </div>
  );
}
