"use client";

import { Columns2, Images, Layers, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { openSheet, toggleSheet } from "@/lib/sheets";
import { useAppStore, type SheetKey } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";
import { cn } from "@/components/ui/cn";

interface TabDef {
  key: SheetKey;
  label: string;
  Icon: LucideIcon;
}

const TABS: TabDef[] = [
  { key: "panel", label: "Filters", Icon: SlidersHorizontal },
  { key: "panel", label: "Layers", Icon: Layers }, // same sheet, different tab
  { key: "results", label: "Results", Icon: Images },
  { key: "compare", label: "Compare", Icon: Columns2 },
];

/**
 * Phone (<768px) bottom navigation: Filters / Layers / Results / Compare.
 * Each item opens its sheet (second tap on the active one closes it);
 * Layers opens the panel sheet with the Layers tab selected. Sits above the
 * map at all times; sheets render over it (z-50) but the bar stays clickable
 * through sheet backdrops (DOM order), so switching tabs never needs a close.
 */
export default function BottomTabBar() {
  const sidebarOpen = useAppStore((s) => s.sidebarOpen);
  const sidebarTab = useAppStore((s) => s.sidebarTab);
  const resultsOpen = useAppStore((s) => s.resultsOpen);
  const compareOpen = useCompareStore((s) => s.drawerOpen);
  const compareReady = useCompareStore((s) => s.result !== null);

  const isActive = (tab: TabDef): boolean => {
    if (tab.key === "panel") {
      // Filters + Layers share the panel sheet; active = open on that tab.
      if (!sidebarOpen) return false;
      return tab.label === "Layers" ? sidebarTab === "layers" : sidebarTab !== "layers";
    }
    if (tab.key === "results") return resultsOpen;
    return compareOpen;
  };

  const onSelect = (tab: TabDef): void => {
    if (tab.key === "panel") {
      // Filters covers every non-Layers panel tab; Layers jumps to that tab.
      const wantTab = tab.label === "Layers" ? "layers" : "filters";
      if (sidebarOpen && sidebarTab === wantTab) {
        toggleSheet("panel");
        return;
      }
      useAppStore.getState().setSidebarTab(wantTab);
      openSheet("panel");
      return;
    }
    toggleSheet(tab.key);
  };

  return (
    <nav
      aria-label="Sections"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="grid h-14 grid-cols-4">
        {TABS.map((tab) => {
          const active = isActive(tab);
          const disabled = tab.key === "compare" && !compareReady;
          const Icon = tab.Icon;
          return (
            <button
              key={`${tab.key}-${tab.label}`}
              type="button"
              aria-current={active ? "page" : undefined}
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (disabled) return;
                onSelect(tab);
              }}
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 px-1 text-[11px] transition-colors duration-150",
                active ? "font-medium text-accent" : "text-muted",
                disabled && "cursor-not-allowed opacity-40",
              )}
            >
              <Icon size={18} strokeWidth={1.8} aria-hidden />
              <span className="truncate">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
