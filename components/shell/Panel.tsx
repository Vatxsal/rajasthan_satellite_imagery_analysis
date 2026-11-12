"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { Bookmark, Layers, PanelLeftClose, Ruler, SlidersHorizontal, Sprout, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import FiltersPanel from "@/components/filters/FiltersPanel";
import LayersPanel from "@/components/layers/LayersPanel";
import { useFormFactor } from "@/lib/hooks/useMediaQuery";
import { useAppStore, type SidebarTabId } from "@/store/useAppStore";
import Button from "@/components/ui/Button";
import BottomSheet from "@/components/ui/BottomSheet";
import { cn } from "@/components/ui/cn";

// Heavier tabs load only when first opened (mobile perf budget).
const FieldsPanel = dynamic(() => import("@/components/fields/FieldsPanel"), {
  ssr: false,
  loading: () => <PanelLoading />,
});
const MeasurePanel = dynamic(() => import("@/components/filters/MeasurePanel"), {
  ssr: false,
  loading: () => <PanelLoading />,
});
const SavedQueriesPanel = dynamic(() => import("@/components/filters/SavedQueriesPanel"), {
  ssr: false,
  loading: () => <PanelLoading />,
});

const TITLES: Record<SidebarTabId, string> = {
  filters: "Search & filters",
  layers: "Layers",
  distance: "Measure",
  queries: "Saved queries",
  fields: "Fields & crops",
};

const TAB_ITEMS: { id: SidebarTabId; label: string; Icon: LucideIcon }[] = [
  { id: "filters", label: "Filters", Icon: SlidersHorizontal },
  { id: "layers", label: "Layers", Icon: Layers },
  { id: "fields", label: "Fields", Icon: Sprout },
  { id: "distance", label: "Measure", Icon: Ruler },
  { id: "queries", label: "Saved", Icon: Bookmark },
];

function PanelLoading() {
  return (
    <p role="status" className="p-4 text-xs text-muted">
      Loading…
    </p>
  );
}

function TabBody() {
  const tab = useAppStore((s) => s.sidebarTab);
  switch (tab) {
    case "layers":
      return <LayersPanel />;
    case "fields":
      return <FieldsPanel />;
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

function PanelTabs() {
  const tab = useAppStore((s) => s.sidebarTab);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);
  return (
    <div
      role="tablist"
      aria-label="Panel sections"
      className="flex gap-1 border-b border-border px-2 pb-2 pt-1 max-lg:overflow-x-auto"
    >
      {TAB_ITEMS.map(({ id, label, Icon }) => {
        const active = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => setSidebarTab(id)}
            className={cn(
              "flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded border px-1 py-1.5 text-xs transition-colors duration-150",
              "max-lg:flex-none max-lg:shrink-0 max-lg:whitespace-nowrap",
              active
                ? "border-border bg-accent-soft font-medium text-accent"
                : "border-transparent text-muted hover:text-text",
            )}
          >
            <Icon size={14} strokeWidth={1.8} className="shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

function PanelHeader({ onClose, closeLabel }: { onClose: () => void; closeLabel: string }) {
  const tab = useAppStore((s) => s.sidebarTab);
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 px-3 pb-1 pt-1">
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text">{TITLES[tab]}</h2>
      <Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}>
        <X size={16} />
      </Button>
    </header>
  );
}

export default function Panel() {
  const factor = useFormFactor();
  if (factor === "desktop") return <DesktopPanel />;
  if (factor === "tablet") return <TabletPanelDrawer />;
  return <PhonePanelSheet />;
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

/**
 * Tablet (768–1023px): overlay side drawer under the top bar. No backdrop —
 * the map stays interactive, exactly like the desktop rail. The results /
 * compare drawer owns the right edge, so the two never collide.
 */
function TabletPanelDrawer() {
  const open = useAppStore((s) => s.sidebarOpen);
  const close = () => useAppStore.setState({ sidebarOpen: false });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <aside
      aria-hidden={!open}
      className={cn(
        "fixed bottom-0 left-0 top-12 z-40 flex w-[clamp(20rem,34vw,22.5rem)] flex-col border-r border-border bg-surface shadow-float transition-[transform,visibility] duration-150 ease-out",
        open ? "translate-x-0" : "invisible -translate-x-full",
      )}
    >
      <PanelHeader onClose={close} closeLabel="Close panel" />
      <PanelTabs />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <TabBody />
      </div>
    </aside>
  );
}

/** Phone (<768px): snap-point bottom sheet owned by the bottom tab bar. */
function PhonePanelSheet() {
  const open = useAppStore((s) => s.sidebarOpen);
  const close = () => useAppStore.setState({ sidebarOpen: false });

  return (
    <BottomSheet open={open} onClose={close} sheetKey="panel" label="Panel">
      <PanelHeader onClose={close} closeLabel="Close panel" />
      <PanelTabs />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <TabBody />
      </div>
    </BottomSheet>
  );
}
