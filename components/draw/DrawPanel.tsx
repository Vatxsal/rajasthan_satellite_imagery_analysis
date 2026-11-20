"use client";

import { useEffect, useRef, useState } from "react";
import { Circle, Hexagon, MousePointer2, Redo2, Square, Trash2, Undo2, Upload, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Button from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import type { DrawTool } from "@/lib/draw/constants";
import { measureDrawGeometry } from "@/lib/draw/geometry";
import { formatArea } from "@/lib/format";
import { useDrawStore } from "@/store/useDrawStore";
import { usePreferencesStore } from "@/store/usePreferencesStore";

const TOOLS: { id: DrawTool; label: string; Icon: LucideIcon; hint: string }[] = [
  { id: "polygon", label: "Polygon", Icon: Hexagon, hint: "Tap to add points" },
  { id: "rectangle", label: "Rectangle", Icon: Square, hint: "Tap two corners" },
  { id: "circle", label: "Circle", Icon: Circle, hint: "Tap centre, then edge" },
  { id: "select", label: "Select", Icon: MousePointer2, hint: "Click a shape to edit" },
];

/**
 * Rail panel: tool picker, undo/redo/clear, the list of shapes drawn in
 * this session, GeoJSON import, and the browser-local saved-shapes list.
 * Selecting a shape from a list opens its card.
 */
export default function DrawPanel() {
  const tool = useDrawStore((s) => s.tool);
  const shapes = useDrawStore((s) => s.shapes);
  const activeShapeId = useDrawStore((s) => s.activeShapeId);
  const canUndo = useDrawStore((s) => s.canUndo);
  const canRedo = useDrawStore((s) => s.canRedo);
  const setTool = useDrawStore((s) => s.setTool);
  const selectShape = useDrawStore((s) => s.selectShape);
  const requestUndo = useDrawStore((s) => s.requestUndo);
  const requestRedo = useDrawStore((s) => s.requestRedo);
  const requestClear = useDrawStore((s) => s.requestClear);
  const savedShapes = useDrawStore((s) => s.savedShapes);
  const refreshSavedShapes = useDrawStore((s) => s.refreshSavedShapes);
  const importGeoJson = useDrawStore((s) => s.importGeoJson);
  const loadSavedShape = useDrawStore((s) => s.loadSavedShape);
  const removeSavedShapeById = useDrawStore((s) => s.removeSavedShapeById);
  const areaUnit = usePreferencesStore((s) => s.values.units.areaUnit);
  const subject = usePreferencesStore((s) => s.subject);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // Saved shapes are keyed by login subject — refresh on mount and on sign-in.
  useEffect(() => {
    refreshSavedShapes();
  }, [refreshSavedShapes, subject]);

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > 512_000) {
      setNotice("File too large (max 512 KB).");
      return;
    }
    setImporting(true);
    setNotice(null);
    try {
      const result = await importGeoJson(await file.text());
      const skipped = result.skipped.map((item) => `${item.count} ${item.reason}`).join(", ");
      if (result.imported > 0 && skipped) {
        setNotice(`Imported ${result.imported} · skipped ${skipped}`);
      } else if (result.imported > 0) {
        setNotice(`Imported ${result.imported} shape(s).`);
      } else {
        setNotice(`Nothing imported${skipped ? ` — ${skipped}` : "."}`);
      }
    } catch {
      setNotice("Could not read that file.");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-5 p-3">
      <section className="space-y-2">
        <h3 className="section-label">Tools</h3>
        <div className="grid grid-cols-2 gap-1.5">
          {TOOLS.map(({ id, label, Icon, hint }) => {
            const active = tool === id;
            return (
              <button
                key={id}
                type="button"
                title={hint}
                aria-pressed={active}
                onClick={() => setTool(active ? null : id)}
                className={cn(
                  "flex min-h-16 flex-col items-center justify-center gap-1 rounded border px-2 py-2.5 text-xs transition-colors duration-150",
                  active
                    ? "border-accent bg-accent-soft font-medium text-accent"
                    : "border-border bg-surface text-text hover:bg-surface-2",
                )}
                data-testid={`draw-tool-${id}`}
              >
                <Icon size={18} strokeWidth={1.8} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>
        <p className="text-[11px] leading-relaxed text-muted">
          Tap the map to add points. Enter finishes, Esc cancels, Backspace removes the last point.
          The map won&rsquo;t pan while a shape tool is on — pan first, then draw.
        </p>
      </section>

      <section className="flex gap-1.5">
        <Button
          variant="secondary"
          size="sm"
          className="flex-1"
          disabled={!canUndo}
          onClick={requestUndo}
          data-testid="draw-undo"
        >
          <Undo2 size={14} />
          Undo
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="flex-1"
          disabled={!canRedo}
          onClick={requestRedo}
          data-testid="draw-redo"
        >
          <Redo2 size={14} />
          Redo
        </Button>
        <Button
          variant="secondary"
          size="sm"
          className="flex-1"
          disabled={shapes.length === 0}
          onClick={requestClear}
          data-testid="draw-clear"
        >
          <Trash2 size={14} />
          Clear
        </Button>
      </section>

      <section className="space-y-2">
        <h3 className="section-label">Shapes ({shapes.length})</h3>
        {shapes.length === 0 ? (
          <p className="rounded border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
            No shapes yet
          </p>
        ) : (
          <ul className="space-y-1">
            {shapes.map((shape) => {
              const metrics = measureDrawGeometry(shape.geometry);
              const active = shape.id === activeShapeId;
              return (
                <li key={shape.id}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => selectShape(shape.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs transition-colors duration-150",
                      active
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-surface hover:bg-surface-2",
                    )}
                    data-testid="draw-shape-row"
                  >
                    <span
                      aria-hidden
                      className="h-3 w-3 shrink-0 rounded-full border border-border"
                      style={{ backgroundColor: shape.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-text">{shape.name}</span>
                    <span className="mono-nums shrink-0 text-muted">
                      {metrics ? formatArea(metrics.areaM2 / 10_000, areaUnit) : "—"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="section-label">Import</h3>
        <input
          ref={fileInputRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          className="hidden"
          data-testid="draw-import-input"
          onChange={(event) => void handleImportFile(event)}
        />
        <Button
          variant="secondary"
          size="sm"
          className="w-full"
          disabled={importing}
          onClick={() => fileInputRef.current?.click()}
          data-testid="draw-import"
        >
          <Upload size={14} />
          {importing ? "Importing…" : "Import GeoJSON"}
        </Button>
        {notice && (
          <p
            role="status"
            data-testid="draw-import-notice"
            className="rounded border border-border bg-surface-2 px-2 py-1.5 text-xs text-muted"
          >
            {notice}
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="section-label">Saved shapes ({savedShapes.length})</h3>
        {savedShapes.length === 0 ? (
          <p className="rounded border border-dashed border-border px-3 py-4 text-center text-xs text-muted">
            Save a shape to keep it in this browser
          </p>
        ) : (
          <ul className="space-y-1">
            {savedShapes.map((saved) => {
              const metrics = measureDrawGeometry(saved.geometry);
              return (
                <li key={saved.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      if (!loadSavedShape(saved.id)) setNotice("Open the map first — saved shapes load onto it.");
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded border border-border bg-surface px-2 py-1.5 text-left text-xs transition-colors duration-150 hover:bg-surface-2"
                    data-testid="draw-saved-row"
                  >
                    <span
                      aria-hidden
                      className="h-3 w-3 shrink-0 rounded-full border border-border"
                      style={{ backgroundColor: saved.color }}
                    />
                    <span className="min-w-0 flex-1 truncate text-text">{saved.name}</span>
                    <span className="mono-nums shrink-0 text-muted">
                      {metrics ? formatArea(metrics.areaM2 / 10_000, areaUnit) : "—"}
                    </span>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove saved shape ${saved.name}`}
                    onClick={() => removeSavedShapeById(saved.id)}
                    data-testid="draw-saved-remove"
                  >
                    <X size={14} />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
