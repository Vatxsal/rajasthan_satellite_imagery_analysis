"use client";

import { useEffect } from "react";
import { DOWNLOAD_FORMAT_LABELS } from "@/lib/downloads";
import { useAppStore } from "@/store/useAppStore";
import Button from "@/components/ui/Button";

function formatMpp(metersPerPixel: number): string {
  return metersPerPixel >= 10 ? `${Math.round(metersPerPixel)}` : metersPerPixel.toFixed(1);
}

/**
 * Reduced-resolution confirmation shown before downloading an area whose
 * native 10 m output exceeds the 2500 px cap (all districts, most tehsils).
 */
export default function DownloadDialog() {
  const dialog = useAppStore((s) => s.downloadDialog);
  const confirmReducedDownload = useAppStore((s) => s.confirmReducedDownload);
  const cancelReducedDownload = useAppStore((s) => s.cancelReducedDownload);

  useEffect(() => {
    if (!dialog) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancelReducedDownload();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog, cancelReducedDownload]);

  if (!dialog) return null;

  const { plan, format, target } = dialog;
  const formatLabel = DOWNLOAD_FORMAT_LABELS[format];

  return (
    <div
      className="fixed inset-0 z-[95] grid place-items-center bg-black/40 p-4"
      role="presentation"
      onClick={cancelReducedDownload}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="download-dialog-title"
        className="w-full max-w-sm rounded-lg border border-border bg-surface p-4 shadow-float"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="download-dialog-title" className="text-sm font-semibold text-text">
          This area is large
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Download {formatLabel} at reduced resolution (~{formatMpp(plan.metersPerPixel)} m/px,{" "}
          <span className="mono-nums text-text">
            {plan.size.width}×{plan.size.height} px
          </span>
          )? Or select a tehsil for full 10 m detail.
        </p>
        <p className="mono-nums mt-1.5 text-[11px] text-muted">
          {target.name} · native would be {plan.native.width}×{plan.native.height} px
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={cancelReducedDownload}>
            Cancel
          </Button>
          <Button variant="primary" autoFocus onClick={confirmReducedDownload}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  );
}
