"use client";

import { Bookmark, Layers, Ruler, SlidersHorizontal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAppStore, type SidebarTabId } from "@/store/useAppStore";
import Tooltip from "@/components/ui/Tooltip";
import { cn } from "@/components/ui/cn";

const ITEMS: { id: SidebarTabId; label: string; Icon: LucideIcon }[] = [
  { id: "filters", label: "Search & filters", Icon: SlidersHorizontal },
  { id: "layers", label: "Layers", Icon: Layers },
  { id: "distance", label: "Measure", Icon: Ruler },
  { id: "queries", label: "Saved queries", Icon: Bookmark },
];

export default function Rail() {
  const activeTab = useAppStore((s) => s.sidebarTab);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);

  return (
    <nav
      aria-label="Tools"
      className="hidden w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2 lg:flex"
    >
      {ITEMS.map(({ id, label, Icon }) => {
        const active = activeTab === id;
        return (
          <Tooltip key={id} content={label}>
            <button
              type="button"
              aria-label={label}
              aria-pressed={active}
              onClick={() => setSidebarTab(id)}
              className={cn(
                "relative grid h-9 w-9 place-items-center rounded transition-colors duration-150",
                active ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-text",
              )}
            >
              {active && (
                <span
                  aria-hidden
                  className="absolute -left-2.5 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-accent"
                />
              )}
              <Icon size={17} strokeWidth={1.8} />
            </button>
          </Tooltip>
        );
      })}
    </nav>
  );
}
