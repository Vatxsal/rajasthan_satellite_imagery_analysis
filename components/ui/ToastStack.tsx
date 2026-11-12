"use client";

import { useEffect } from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useFormFactor } from "@/lib/hooks/useMediaQuery";
import { useAppStore, type ToastItem } from "@/store/useAppStore";
import { cn } from "@/components/ui/cn";

const TONE_ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
} as const;

function ToastRow({ toast }: { toast: ToastItem }) {
  const dismissToast = useAppStore((s) => s.dismissToast);
  const { id, tone, message, duration } = toast;
  const Icon = TONE_ICONS[tone];

  useEffect(() => {
    if (duration === null) return;
    const timer = window.setTimeout(() => dismissToast(id), duration);
    return () => window.clearTimeout(timer);
    // Re-arm when the toast is updated (e.g. "Preparing…" → result).
  }, [id, duration, message, dismissToast]);

  return (
    <div
      className={cn(
        "flex max-w-[min(88vw,26rem)] items-center gap-2 rounded border bg-surface px-3 py-2 text-xs shadow-float",
        tone === "error" && "border-danger/50",
        tone === "success" && "border-success/50",
        tone === "info" && "border-border",
      )}
      data-tone={tone}
    >
      <Icon
        size={14}
        className={cn(
          "shrink-0",
          tone === "error" ? "text-danger" : tone === "success" ? "text-success" : "text-muted",
        )}
        aria-hidden
      />
      <span className="min-w-0 flex-1 text-text">{message}</span>
      <button
        type="button"
        aria-label="Dismiss notification"
        className="shrink-0 text-muted transition-colors duration-150 hover:text-text"
        onClick={() => dismissToast(id)}
      >
        <X size={13} />
      </button>
    </div>
  );
}

/**
 * Transient notifications (download progress/results). Stacks bottom-center,
 * sitting just above the results strip on desktop and above the tab bar /
 * open sheet on phones.
 */
export default function ToastStack() {
  const toasts = useAppStore((s) => s.toasts);
  const stripOpen = useAppStore((s) => s.resultsOpen);
  const stripHeightPx = useAppStore((s) => s.stripHeightPx);
  const searching = useAppStore((s) => s.searching);
  const hasSearched = useAppStore((s) => s.hasSearched);
  const factor = useFormFactor();

  if (toasts.length === 0) return null;

  const bottom =
    factor === "desktop"
      ? stripOpen && (searching || hasSearched)
        ? stripHeightPx + 12
        : 12
      : "calc(var(--tabbar-h, 0px) + var(--sheet-h, 0px) + 12px)";

  return (
    <div
      className="fixed left-1/2 z-[90] flex -translate-x-1/2 flex-col items-center gap-2 transition-[bottom] duration-150 ease-out"
      style={{ bottom }}
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
