"use client";

import { useEffect } from "react";
import { ChevronDown, ChevronUp, GitCompare, Loader2, X } from "lucide-react";
import { cn } from "@/components/ui/cn";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import { QuotaReadout } from "@/components/ui/FeatureLock";
import DetailConfirmDialog from "./DetailConfirmDialog";
import { COMPARE_STAGE_LABELS, useCompareStore, type CompareDetail } from "@/store/useCompareStore";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";
import { selectCan, useSession } from "@/store/useSession";

export function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const month = new Date(Number(y), Number(m) - 1, Number(d)).toLocaleString("en", { month: "short" });
  return `${d} ${month} ${y}`;
}

/** Scene-strip header button that arms A/B date assignment. */
export function CompareToggle() {
  const compareMode = useCompareStore((s) => s.compareMode);
  const toggleCompareMode = useCompareStore((s) => s.toggleCompareMode);
  return (
    <button
      type="button"
      aria-pressed={compareMode}
      title="Compare two dates for this area"
      onClick={toggleCompareMode}
      className={cn(
        "flex h-7 items-center gap-1 rounded border px-2 text-xs transition-colors duration-150",
        compareMode
          ? "border-accent bg-accent text-accent-fg"
          : "border-border bg-surface text-muted hover:text-text",
      )}
    >
      <GitCompare size={13} />
      {compareMode ? "Comparing" : "Compare"}
    </button>
  );
}

function SlotChip({ slot, date }: { slot: "A" | "B"; date: string | null }) {
  const toggleSlot = useCompareStore((s) => s.toggleSlot);
  return (
    <span
      className={cn(
        "mono-nums inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
        date ? "border-border bg-surface text-text" : "border-dashed border-border text-muted",
      )}
    >
      <span className={date ? "font-semibold text-accent" : "font-semibold"}>{slot}</span>
      {date ? formatShortDate(date) : "pick a scene"}
      {date && (
        <button
          type="button"
          aria-label={`Clear date ${slot}`}
          onClick={() => toggleSlot(date, slot === "A" ? "dateA" : "dateB")}
          className="text-muted transition-colors duration-150 hover:text-text"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

/**
 * Compare bar under the scene-strip header: A/B chips, gap, live progress,
 * the Analyze button and a reopen shortcut for a finished result.
 */
export default function CompareBar() {
  const compareMode = useCompareStore((s) => s.compareMode);
  const dateA = useCompareStore((s) => s.dateA);
  const dateB = useCompareStore((s) => s.dateB);
  const running = useCompareStore((s) => s.running);
  const stage = useCompareStore((s) => s.stage);
  const blockProgress = useCompareStore((s) => s.blockProgress);
  const error = useCompareStore((s) => s.error);
  const result = useCompareStore((s) => s.result);
  const drawerOpen = useCompareStore((s) => s.drawerOpen);
  const stripExpanded = useCompareStore((s) => s.stripExpanded);
  const setStripExpanded = useCompareStore((s) => s.setStripExpanded);
  const run = useCompareStore((s) => s.run);
  const setDrawerOpen = useCompareStore((s) => s.setDrawerOpen);
  const detail = useCompareStore((s) => s.detail);
  const detailTouched = useCompareStore((s) => s.detailTouched);
  const setDetail = useCompareStore((s) => s.setDetail);
  const applyDetailDefault = useCompareStore((s) => s.applyDetailDefault);

  const selectionLevel = useAppStore((s) => selectActiveSelection(s)?.level ?? null);
  const canDetailed = selectCan(useSession.getState(), "compare.detailed");

  // District detail defaults to Smart (screening keeps the block count sane);
  // tehsil/ILR default to Quick. Stops once the user picks a mode themselves.
  useEffect(() => {
    if (detailTouched) return;
    if (selectionLevel === "district" && detail === "quick") applyDetailDefault("smart");
    else if (selectionLevel !== "district" && detail === "smart") applyDetailDefault("quick");
  }, [selectionLevel, detail, detailTouched, applyDetailDefault]);

  if (!compareMode) return null;

  const gapDays =
    dateA && dateB ? Math.round(Math.abs(Date.parse(dateB) - Date.parse(dateA)) / 86_400_000) : null;
  const shortGap = gapDays !== null && gapDays < 30;
  const canRun = Boolean(dateA && dateB) && !running;

  return (
    <div className="flex w-full min-w-0 flex-wrap items-center gap-2 border-b border-border bg-surface-2 px-3 py-1.5">
      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted" title="Pick one scene as A and another as B">
        <GitCompare size={13} />
        Dates
      </span>
      <SlotChip slot="A" date={dateA} />
      <span aria-hidden className="text-[11px] text-muted">→</span>
      <SlotChip slot="B" date={dateB} />
      {gapDays !== null && (
        <span
          className={cn(
            "mono-nums shrink-0 text-[11px]",
            shortGap ? "text-warning" : "text-muted",
          )}
          title={
            shortGap
              ? "Under 30 days — seasonal noise may dominate the result."
              : "Interval between the two acquisitions."
          }
        >
          {gapDays}d
          {shortGap && " short gap"}
        </span>
      )}

      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        {running && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            <Loader2 size={13} className="animate-spin" aria-hidden />
            {stage === "block" && blockProgress
              ? `Block ${blockProgress.index}/${blockProgress.total}`
              : stage
                ? COMPARE_STAGE_LABELS[stage]
                : "Working…"}
          </span>
        )}
        {!running && error && (
          <span className="max-w-[18rem] truncate text-[11px] text-danger" title={error.message}>
            {error.message}
          </span>
        )}
        {!running && result && !drawerOpen && (
          <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => setDrawerOpen(true)}>
            Show results
          </Button>
        )}
        {canDetailed && (
          <Segmented<CompareDetail>
            options={[
              { value: "quick", label: "Quick" },
              { value: "smart", label: "Smart" },
              { value: "detailed", label: "Detailed" },
            ]}
            value={detail}
            onChange={setDetail}
            ariaLabel="Detail level"
            fill={false}
            className="h-6 shrink-0 rounded-sm [&>button]:h-5 [&>button]:rounded-sm [&>button]:px-1.5 [&>button]:py-0.5 [&>button]:text-[11px]"
          />
        )}
        <button
          type="button"
          aria-expanded={stripExpanded}
          aria-label={stripExpanded ? "Hide scene cards" : "Show scene cards"}
          title={stripExpanded ? "Hide scene cards (slim strip)" : "Show scene cards"}
          onClick={() => setStripExpanded(!stripExpanded)}
          className={cn(
            "grid h-6 w-6 shrink-0 place-items-center rounded border transition-colors duration-150",
            stripExpanded
              ? "border-border bg-surface text-muted hover:text-text"
              : "border-accent bg-accent-soft text-accent",
          )}
        >
          {stripExpanded ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        <Button
          variant="primary"
          size="sm"
          className="h-6 px-2.5 text-[11px]"
          disabled={!canRun}
          title={dateA && dateB ? "Run change detection" : "Pick two dates first"}
          onClick={() => void run()}
        >
          {running ? "Analyzing…" : "Analyze"}
        </Button>
        <QuotaReadout kind={detail === "quick" ? "compare" : "detailed"} className="max-w-[12rem]" />
      </div>
      <DetailConfirmDialog />
    </div>
  );
}
