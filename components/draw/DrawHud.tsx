"use client";

import type { CSSProperties } from "react";
import Button from "@/components/ui/Button";
import { DRAW_TOOL_LABELS, type DrawTool } from "@/lib/draw/constants";
import { formatArea, formatLength } from "@/lib/format";
import { useDrawStore } from "@/store/useDrawStore";
import { usePreferencesStore } from "@/store/usePreferencesStore";

interface DrawHudProps {
  /** Bottom offset from MapCanvas (strip/sheet-aware). */
  style?: CSSProperties;
}

function isDrawTool(tool: DrawTool | null): tool is Exclude<DrawTool, "select"> {
  return tool === "polygon" || tool === "rectangle" || tool === "circle";
}

/**
 * Bottom-centre live feedback while a shape tool is armed: area, perimeter,
 * vertex count, the current validity reason, and touch-visible Finish /
 * Cancel buttons (keyboard Enter/Esc/Backspace work alongside them).
 */
export default function DrawHud({ style }: DrawHudProps) {
  const tool = useDrawStore((s) => s.tool);
  const draft = useDrawStore((s) => s.draft);
  const requestFinish = useDrawStore((s) => s.requestFinish);
  const requestCancel = useDrawStore((s) => s.requestCancel);
  const areaUnit = usePreferencesStore((s) => s.values.units.areaUnit);

  if (!isDrawTool(tool)) return null;

  const { metrics, validity } = draft;

  return (
    <div
      className="pointer-events-none absolute left-1/2 z-20 w-max max-w-[calc(100vw-1.5rem)] -translate-x-1/2"
      style={style}
      data-testid="draw-hud"
    >
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded border border-border bg-surface px-3 py-2 text-xs shadow-float">
          <span className="font-medium text-text">{DRAW_TOOL_LABELS[tool]}</span>
          {metrics && (
            <>
              <span className="mono-nums text-muted">
                Area <span className="text-text">{formatArea(metrics.areaM2 / 10_000, areaUnit)}</span>
              </span>
              <span className="mono-nums text-muted">
                Perimeter <span className="text-text">{formatLength(metrics.perimeterM)}</span>
              </span>
              <span className="mono-nums text-muted">
                Vertices <span className="text-text">{metrics.vertices}</span>
              </span>
            </>
          )}
          <span
            role="status"
            className={validity.ok ? "text-success" : validity.kind === "error" ? "text-danger" : "text-muted"}
          >
            {validity.ok ? "Shape is valid" : validity.message}
          </span>
          <span className="hidden gap-2 text-muted md:inline">
            <span>Enter finish</span>
            <span>Esc cancel</span>
            <span>Backspace undo point</span>
          </span>
        </div>
        <div className="pointer-events-auto flex gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!validity.ok}
            onClick={requestFinish}
            data-testid="draw-finish"
          >
            Finish
          </Button>
          <Button variant="secondary" size="sm" onClick={requestCancel} data-testid="draw-cancel">
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
