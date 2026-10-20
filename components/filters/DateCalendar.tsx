"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAppStore } from "@/store/useAppStore";
import { cn } from "@/components/ui/cn";

/**
 * EO Browser-style available-dates calendar (replaces the from/to inputs in
 * "Custom" mode). Dates with scenes for the current area + cloud filter are
 * highlighted; clicking one selects that scene on the map.
 */

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function startOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 1)).getUTCDay(); // 0=Sun
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

export default function DateCalendar() {
  const scenes = useAppStore((s) => s.scenes);
  const activeSceneId = useAppStore((s) => s.activeSceneId);
  const setActiveScene = useAppStore((s) => s.setActiveScene);
  const setFromDate = useAppStore((s) => s.setFromDate);
  const setToDate = useAppStore((s) => s.setToDate);

  const available = useMemo(() => {
    const map = new Map<string, string>(); // date → scene id
    for (const scene of scenes) map.set(scene.date, scene.id);
    return map;
  }, [scenes]);

  const anchor = useMemo(() => {
    const newest = scenes.reduce<string | null>(
      (latest, scene) => (latest === null || scene.date > latest ? scene.date : latest),
      null,
    );
    const base = newest ?? new Date().toISOString().slice(0, 10);
    const [y, m] = base.split("-").map(Number);
    return { year: y ?? 2026, month: (m ?? 1) - 1 };
  }, [scenes]);

  const view = useAppStore((s) => s.calendarMonth);
  const setCalendarMonth = useAppStore((s) => s.setCalendarMonth);
  const { year, month } = view ?? anchor;

  const shift = (delta: number) => {
    const next = new Date(Date.UTC(year, month + delta, 1));
    setCalendarMonth({ year: next.getUTCFullYear(), month: next.getUTCMonth() });
  };

  const leading = startOfMonth(year, month);
  const total = daysInMonth(year, month);
  const monthLabel = new Date(Date.UTC(year, month, 1)).toLocaleString("en", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="rounded border border-border bg-surface p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => shift(-1)}
          className="grid h-6 w-6 place-items-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          <ChevronLeft size={14} />
        </button>
        <p className="text-xs font-medium text-text">{monthLabel}</p>
        <button
          type="button"
          aria-label="Next month"
          onClick={() => shift(1)}
          className="grid h-6 w-6 place-items-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
        >
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-px">
        {WEEKDAYS.map((day) => (
          <span key={day} className="py-0.5 text-center text-[10px] text-muted">
            {day}
          </span>
        ))}
        {Array.from({ length: leading }, (_, i) => (
          <span key={`pad-${i}`} />
        ))}
        {Array.from({ length: total }, (_, i) => {
          const day = i + 1;
          const date = iso(year, month, day);
          const sceneId = available.get(date);
          const selected = sceneId !== undefined && sceneId === activeSceneId;
          return (
            <button
              key={date}
              type="button"
              disabled={!sceneId}
              title={sceneId ? `${date} · scene available` : "No scene"}
              onClick={() => {
                if (!sceneId) return;
                setActiveScene(sceneId);
                setFromDate(date);
                setToDate(date);
              }}
              className={cn(
                "mono-nums h-6 rounded-sm text-[11px] transition-colors duration-150",
                sceneId
                  ? "cursor-pointer font-medium text-text hover:bg-accent-soft"
                  : "cursor-default text-muted/50",
                selected && "bg-accent text-white hover:bg-accent",
                sceneId && !selected && "bg-success/15",
              )}
            >
              {day}
            </button>
          );
        })}
      </div>
      <p className="mt-1.5 text-[10px] text-muted">Highlighted dates have scenes · click to select</p>
    </div>
  );
}
