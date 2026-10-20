"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";
import { cn } from "@/components/ui/cn";
import SceneCard from "./SceneCard";
import SceneSkeleton from "./SceneSkeleton";

type SortMode = "cloud" | "date";

interface SceneStripProps {
  variant?: "docked" | "inline";
}

const SORT_LABELS: Record<SortMode, string> = {
  cloud: "lowest cloud first",
  date: "newest first",
};

export default function SceneStrip({ variant = "docked" }: SceneStripProps) {
  const scenes = useAppStore((s) => s.scenes);
  const searching = useAppStore((s) => s.searching);
  const hasSearched = useAppStore((s) => s.hasSearched);
  const searchError = useAppStore((s) => s.searchError);
  const stripOpen = useAppStore((s) => s.resultsOpen);
  const setResultsOpen = useAppStore((s) => s.setResultsOpen);
  const setStripHeightPx = useAppStore((s) => s.setStripHeightPx);
  const [sort, setSort] = useState<SortMode>("cloud");
  const sectionRef = useRef<HTMLElement | null>(null);

  const active = searching || hasSearched;

  // The docked strip sizes to its content; publish the measured height so
  // map controls and the maplibre attribution stay above it.
  useEffect(() => {
    if (variant !== "docked" || !stripOpen || !active) return;
    const element = sectionRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setStripHeightPx(Math.round(element.getBoundingClientRect().height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [variant, stripOpen, active, setStripHeightPx]);

  const sorted = useMemo(() => {
    const list = [...scenes];
    if (sort === "cloud") {
      // Full coverage first, then lowest cloud, then newest.
      list.sort(
        (a, b) =>
          Number((b.coverage ?? 100) >= 90) - Number((a.coverage ?? 100) >= 90) ||
          a.cloudCover - b.cloudCover ||
          (a.date < b.date ? 1 : -1),
      );
    } else {
      list.sort((a, b) => (a.date < b.date ? 1 : -1));
    }
    return list;
  }, [scenes, sort]);

  if (!active) return null;

  // Desktop: collapsed strip shows a small reopen pill above the map bottom.
  if (variant === "docked" && !stripOpen) {
    if (searching || scenes.length === 0) return null;
    return (
      <button
        type="button"
        onClick={() => setResultsOpen(true)}
        className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1.5 rounded border border-border bg-surface px-2.5 py-1.5 text-xs text-muted shadow-float transition-colors duration-150 hover:text-text"
      >
        <ChevronUp size={13} />
        <span className="mono-nums">{scenes.length}</span> scenes
      </button>
    );
  }

  const header = (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-2 border-border px-3",
        variant === "docked" ? "h-9 border-b" : "pt-2",
      )}
    >
      <p className="truncate text-xs text-muted">
        <span className="mono-nums text-text">{searching ? "…" : scenes.length}</span>
        {" scenes · "}
        {SORT_LABELS[sort]}
      </p>
      <div className="flex shrink-0 items-center gap-1">
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label="Sort scenes"
              className="flex h-7 items-center gap-1 rounded border border-border bg-surface px-2 text-xs text-muted transition-colors duration-150 hover:text-text"
            >
              Sort
              <ChevronDown size={12} />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => setSort("cloud")}>
              {sort === "cloud" && <Check size={13} className="text-accent" />}
              Lowest cloud
            </MenuItem>
            <MenuItem onSelect={() => setSort("date")}>
              {sort === "date" && <Check size={13} className="text-accent" />}
              Newest first
            </MenuItem>
          </MenuContent>
        </Menu>
        {variant === "docked" && (
          <button
            type="button"
            aria-label="Collapse scenes"
            onClick={() => setResultsOpen(false)}
            className="grid h-7 w-7 place-items-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>
    </div>
  );

  const body = (
    <div
      className={cn(
        "flex gap-2 overflow-x-auto px-3 pb-2",
        variant === "docked" ? "min-h-0 flex-1 pt-2" : "pt-2",
      )}
    >
      {searching && (
        <>
          <SceneSkeleton />
          <SceneSkeleton />
          <SceneSkeleton />
          <SceneSkeleton />
          <SceneSkeleton />
        </>
      )}

      {!searching && scenes.length === 0 && !searchError && (
        <p className="py-4 text-sm text-muted">No scenes match these filters.</p>
      )}

      {!searching && searchError && (
        <p className="py-4 text-sm text-danger">{searchError}</p>
      )}

      {!searching && sorted.map((scene) => <SceneCard key={scene.id} scene={scene} />)}
    </div>
  );

  if (variant === "inline") {
    return <div className="bg-surface">{header}{body}</div>;
  }

  return (
    <section
      ref={sectionRef}
      aria-label="Search results"
      className="absolute inset-x-0 bottom-0 z-30 flex max-h-[50vh] flex-col border-t border-border bg-surface"
    >
      {header}
      {body}
    </section>
  );
}
