"use client";

import { useEffect } from "react";
import { Bookmark, Layers, PanelLeftClose, Ruler, SlidersHorizontal, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import FiltersPanel from "@/components/filters/FiltersPanel";
import MeasurePanel from "@/components/filters/MeasurePanel";
import SavedQueriesPanel from "@/components/filters/SavedQueriesPanel";
import LayersPanel from "@/components/layers/LayersPanel";
import SceneStrip from "@/components/scenes/SceneStrip";
import { useIsDesktop } from "@/lib/hooks/useMediaQuery";
import { useAppStore, type SidebarTabId } from "@/store/useAppStore";
import Button from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";

const TITLES: Record<SidebarTabId, string> = {
  filters: "Search & filters",
  layers: "Layers",
  distance: "Measure",
  queries: "Saved queries",
};

const TAB_ITEMS: { id: SidebarTabId; label: string; Icon: LucideIcon }[] = [
  { id: "filters", label: "Filters", Icon: SlidersHorizontal },
  { id: "layers", label: "Layers", Icon: Layers },
  { id: "distance", label: "Measure", Icon: Ruler },
  { id: "queries", label: "Saved", Icon: Bookmark },
];

function TabBody() {
  const tab = useAppStore((s) => s.sidebarTab);
  switch (tab) {
    case "layers":
      return <LayersPanel />;
    case "distance":
      return <MeasurePanel />;
    case "queries":
      return <SavedQueriesPanel />;
    default:
      return <FiltersPanel />;
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export default function Panel() {
  const isDesktop = useIsDesktop();
  return isDesktop ? <DesktopPanel /> : <MobileSheet />;
}

function DesktopPanel() {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const tab = useAppStore((s) => s.sidebarTab);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "[") {
        event.preventDefault();
        setSidebarCollapsed(!useAppStore.getState().sidebarCollapsed);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSidebarCollapsed]);

  return (
    <aside
      aria-hidden={collapsed}
      className={cn(
        "hidden h-full shrink-0 overflow-hidden border-r border-border bg-surface transition-[width] duration-150 ease-out lg:block",
        collapsed ? "w-0 border-r-0" : "w-80",
      )}
    >
      <div className="flex h-full w-80 flex-col">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 className="text-sm font-semibold text-text">{TITLES[tab]}</h2>
          <div className="flex items-center gap-1.5">
            <kbd className="mono-nums hidden rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted xl:block">
              [
            </kbd>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Collapse panel"
              onClick={() => setSidebarCollapsed(true)}
            >
              <PanelLeftClose size={16} />
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabBody />
        </div>
      </div>
    </aside>
  );
}

function MobileSheet() {
  const open = useAppStore((s) => s.sidebarOpen);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const tab = useAppStore((s) => s.sidebarTab);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);
  const hasSearched = useAppStore((s) => s.hasSearched);
  const searching = useAppStore((s) => s.searching);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && useAppStore.getState().sidebarOpen) {
        useAppStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close panel"
          onClick={toggleSidebar}
          className="fixed inset-0 z-40 bg-black/30 lg:hidden"
        />
      )}
      <section
        aria-hidden={!open}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex max-h-[78vh] flex-col rounded-t-lg border-t border-border bg-surface lg:hidden",
          "transition-transform duration-150 ease-out",
          open ? "translate-y-0" : "translate-y-full",
        )}
      >
        <div className="flex justify-center pt-2">
          <span aria-hidden className="h-1 w-9 rounded-full bg-border" />
        </div>

        <header className="flex items-center justify-between px-3 pb-2 pt-2">
          <h2 className="text-sm font-semibold text-text">{TITLES[tab]}</h2>
          <Button variant="ghost" size="icon" aria-label="Close panel" onClick={toggleSidebar}>
            <X size={16} />
          </Button>
        </header>

        <div className="flex gap-1 border-b border-border px-2 pb-2">
          {TAB_ITEMS.map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setSidebarTab(id)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded border px-1 py-1.5 text-xs transition-colors duration-150",
                  active
                    ? "border-border bg-accent-soft text-accent"
                    : "border-transparent text-muted hover:text-text",
                )}
              >
                <Icon size={14} strokeWidth={1.8} />
                {label}
              </button>
            );
          })}
        </div>

        {(hasSearched || searching) && (
          <div className="border-b border-border">
            <SceneStrip variant="inline" />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <TabBody />
        </div>
      </section>
    </>
  );
}
