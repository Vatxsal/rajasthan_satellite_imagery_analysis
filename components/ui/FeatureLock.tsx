"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Lock, LogIn, Send } from "lucide-react";
import { CAPABILITY_LABELS, type Capability, type QuotaKind } from "@/lib/auth/permissions";
import { useLocked, useQuotaToday } from "@/store/useSession";
import Button from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";

/** True when the current session may not use `capability` (server still enforces). */
export { useLocked };

function goSignIn(): void {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`);
}

function goRequestAccess(): void {
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(
    next === "/" ? "/login?mode=request" : `/login?mode=request&next=${encodeURIComponent(next)}`,
  );
}

export interface FeatureLockProps {
  capability: Capability;
  /** Overrides the capability label in the popover. */
  label?: string;
  className?: string;
  /** Compact icon-only trigger (default) vs a wider button. */
  size?: "icon" | "wide";
}

/**
 * Lock control for an SSO-only feature: a padlock button that opens a small
 * popover — "Available with an SSO ID" plus Sign in / Request access.
 * Render it beside (or instead of) the disabled control; the API returns the
 * same FORBIDDEN_ROLE contract if anything bypasses the UI.
 */
export default function FeatureLock({ capability, label, className, size = "icon" }: FeatureLockProps) {
  const locked = useLocked(capability);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!locked) return null;

  const title = label ?? CAPABILITY_LABELS[capability];

  return (
    <div ref={rootRef} className={cn("relative inline-flex", className)}>
      <Button
        type="button"
        variant="ghost"
        size={size === "icon" ? "icon" : "sm"}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${title} — available with an SSO ID`}
        title={`${title} — available with an SSO ID`}
        onClick={() => setOpen((value) => !value)}
        className={size === "wide" ? "gap-1.5" : undefined}
      >
        <Lock size={size === "icon" ? 15 : 13} aria-hidden />
        {size === "wide" && <span>SSO only</span>}
      </Button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={`${title} — SSO required`}
          className="absolute right-0 top-full z-[90] mt-1 w-56 rounded border border-border bg-surface p-2.5 shadow-float"
        >
          <p className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-text">
            <Lock size={12} className="shrink-0 text-muted" aria-hidden />
            Available with an SSO ID
          </p>
          <p className="mb-2 text-[11px] leading-snug text-muted">
            {title} is part of the full-access SSO session. Guests browse with tighter limits.
          </p>
          <div className="flex flex-col gap-1.5">
            <Button type="button" variant="primary" size="sm" className="w-full" onClick={goSignIn}>
              <LogIn size={13} aria-hidden />
              Sign in
            </Button>
            <Button type="button" variant="secondary" size="sm" className="w-full" onClick={goRequestAccess}>
              <Send size={13} aria-hidden />
              Request access
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const QUOTA_LABELS: Record<QuotaKind, string> = {
  search: "searches",
  compare: "analyses",
  aiSummary: "AI summaries",
};

/**
 * "2 of 3 analyses left today" — binding (session OR IP) remaining budget
 * from the session payload. Renders nothing until usageToday has loaded.
 */
export function QuotaReadout({
  kind,
  className,
  showWhenFull = false,
}: {
  kind: QuotaKind;
  className?: string;
  /** Also render when nothing is used yet (default: only once a unit is spent). */
  showWhenFull?: boolean;
}) {
  const usage = useQuotaToday(kind);
  if (!usage || usage.limit <= 0) return null;
  if (!showWhenFull && usage.used <= 0) return null;
  if (usage.remaining <= 0) {
    return (
      <p className={cn("text-[11px] text-warning", className)}>
        Daily {QUOTA_LABELS[kind]} limit reached ({usage.limit}/day) · resets 00:00 UTC
      </p>
    );
  }
  return (
    <p className={cn("mono-nums text-[11px] text-muted", className)}>
      {usage.remaining} of {usage.limit} {QUOTA_LABELS[kind]} left today
    </p>
  );
}
