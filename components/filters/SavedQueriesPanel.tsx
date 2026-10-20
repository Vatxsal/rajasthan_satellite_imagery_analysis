"use client";

import { Check, Play } from "lucide-react";
import { useState } from "react";
import type { CompositeId } from "@/lib/data";
import { useDistricts } from "@/lib/hooks/useAreas";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/components/ui/cn";

interface PredefinedQuery {
  id: string;
  name: string;
  description: string;
  districtName: string;
  days: number;
  maxCloudCover: number;
  composite: CompositeId;
}

const QUERIES: PredefinedQuery[] = [
  {
    id: "q-kharif-jaipur",
    name: "Kharif watch — Jaipur",
    description: "Jaipur · 120 days · ≤25% cloud · false colour",
    districtName: "Jaipur",
    days: 120,
    maxCloudCover: 25,
    composite: "false-color",
  },
  {
    id: "q-drought-bikaner",
    name: "Drought monitor — Bikaner",
    description: "Bikaner · 180 days · ≤40% cloud · NDVI",
    districtName: "Bikaner",
    days: 180,
    maxCloudCover: 40,
    composite: "ndvi",
  },
  {
    id: "q-clear-jodhpur",
    name: "Clear-sky archive — Jodhpur",
    description: "Jodhpur · 90 days · ≤10% cloud · true colour",
    districtName: "Jodhpur",
    days: 90,
    maxCloudCover: 10,
    composite: "true-color",
  },
  {
    id: "q-basin-udaipur",
    name: "Basin review — Udaipur",
    description: "Udaipur · 60 days · ≤30% cloud · false colour",
    districtName: "Udaipur",
    days: 60,
    maxCloudCover: 30,
    composite: "false-color",
  },
];

function isoDayAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function SavedQueriesPanel() {
  const districtsState = useDistricts();
  const [appliedId, setAppliedId] = useState<string | null>(null);

  const setDistrict = useAppStore((s) => s.setDistrict);
  const setFromDate = useAppStore((s) => s.setFromDate);
  const setToDate = useAppStore((s) => s.setToDate);
  const setMaxCloudCover = useAppStore((s) => s.setMaxCloudCover);
  const setComposite = useAppStore((s) => s.setComposite);
  const setSidebarTab = useAppStore((s) => s.setSidebarTab);

  const apply = (query: PredefinedQuery) => {
    const district = districtsState.data?.find((d) => d.name === query.districtName) ?? null;
    setDistrict(district);
    setFromDate(isoDayAgo(query.days));
    setToDate(todayIso());
    setMaxCloudCover(query.maxCloudCover);
    setComposite(query.composite);
    setAppliedId(query.id);
    setSidebarTab("filters");
  };

  return (
    <div className="space-y-3 p-3">
      {districtsState.loading && (
        <p className="rounded border border-border bg-surface-2 px-3 py-2 text-sm text-muted">
          Loading…
        </p>
      )}

      {QUERIES.map((query) => {
        const applied = appliedId === query.id;
        return (
          <button
            key={query.id}
            type="button"
            onClick={() => apply(query)}
            className={cn(
              "w-full rounded border p-2.5 text-left transition-colors duration-150",
              applied
                ? "border-accent bg-accent-soft"
                : "border-border bg-surface hover:bg-surface-2",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-text">{query.name}</p>
                <p className="mono-nums mt-0.5 truncate text-xs text-muted">{query.description}</p>
              </div>
              {applied ? (
                <Check size={14} className="mt-0.5 shrink-0 text-accent" />
              ) : (
                <Play size={13} className="mt-0.5 shrink-0 text-muted" />
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
