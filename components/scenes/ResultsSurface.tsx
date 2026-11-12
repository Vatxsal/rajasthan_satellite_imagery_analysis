"use client";

import { ChevronUp, X } from "lucide-react";
import SceneStrip from "@/components/scenes/SceneStrip";
import { useFormFactor } from "@/lib/hooks/useMediaQuery";
import { useAppStore } from "@/store/useAppStore";
import BottomSheet from "@/components/ui/BottomSheet";
import Button from "@/components/ui/Button";

/**
 * Where search results live outside the desktop docked strip:
 *   phone  — snap-point bottom sheet (inline horizontal card strip)
 *   tablet — right-hand overlay drawer (vertical card stack)
 *   desktop — null (the docked SceneStrip in the map column owns results)
 *
 * Visibility reuses `resultsOpen` — runSearch() already turns it on, so the
 * surface appears automatically after every search on every form factor.
 */
export default function ResultsSurface() {
  const factor = useFormFactor();
  if (factor === "phone") return <PhoneResultsSheet />;
  if (factor === "tablet") return <TabletResultsDrawer />;
  return null;
}

function useResultsState() {
  const open = useAppStore((s) => s.resultsOpen);
  const searching = useAppStore((s) => s.searching);
  const hasSearched = useAppStore((s) => s.hasSearched);
  const scenes = useAppStore((s) => s.scenes);
  const setOpen = useAppStore((s) => s.setResultsOpen);
  return {
    open,
    active: searching || hasSearched,
    searching,
    count: scenes.length,
    setOpen,
  };
}

function PhoneResultsSheet() {
  const { open, active, setOpen } = useResultsState();
  const close = () => setOpen(false);

  return (
    <BottomSheet open={open && active} onClose={close} sheetKey="results" label="Search results">
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">Results</h2>
        <Button variant="ghost" size="icon" aria-label="Close results" onClick={close}>
          <X size={16} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <SceneStrip variant="inline" />
      </div>
    </BottomSheet>
  );
}

function TabletResultsDrawer() {
  const { open, active, searching, count, setOpen } = useResultsState();

  if (!active) return null;

  return (
    <>
      <aside
        aria-hidden={!open}
        className={
          "fixed bottom-0 right-0 top-12 z-40 flex w-[clamp(20rem,36vw,24rem)] flex-col border-l border-border bg-surface shadow-float transition-[transform,visibility] duration-150 ease-out " +
          (open ? "translate-x-0" : "invisible translate-x-full")
        }
      >
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">
            Results
            <span className="ml-2 text-xs font-normal text-muted">
              <span className="mono-nums">{searching ? "…" : count}</span> scenes
            </span>
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close results" onClick={() => setOpen(false)}>
            <X size={16} />
          </Button>
        </header>
        <div className="min-h-0 flex-1">
          <SceneStrip variant="stack" />
        </div>
      </aside>

      {!open && !searching && count > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-muted shadow-float transition-colors duration-150 hover:text-text"
        >
          <ChevronUp size={13} />
          <span className="mono-nums">{count}</span> scenes
        </button>
      )}
    </>
  );
}
