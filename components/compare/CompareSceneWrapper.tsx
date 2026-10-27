"use client";

import type { Scene } from "@/lib/data";
import { cn } from "@/components/ui/cn";
import { useCompareStore } from "@/store/useCompareStore";
import SceneCard from "@/components/scenes/SceneCard";

interface CompareSceneWrapperProps {
  scene: Scene;
}

/**
 * SceneCard stays untouched: compare mode appends an A/B assignment row
 * underneath it (stopPropagation is implicit — the buttons are outside the
 * card's clickable node).
 */
export default function CompareSceneWrapper({ scene }: CompareSceneWrapperProps) {
  const dateA = useCompareStore((s) => s.dateA);
  const dateB = useCompareStore((s) => s.dateB);
  const running = useCompareStore((s) => s.running);
  const toggleSlot = useCompareStore((s) => s.toggleSlot);

  const isA = dateA === scene.date;
  const isB = dateB === scene.date;

  const slotButton = (slot: "dateA" | "dateB", active: boolean) => (
    <button
      type="button"
      disabled={running}
      aria-pressed={active}
      aria-label={`${slot === "dateA" ? "Date A" : "Date B"}: ${scene.date}`}
      title={
        active
          ? `Clear ${slot === "dateA" ? "date A" : "date B"}`
          : `Use ${scene.date} as ${slot === "dateA" ? "date A" : "date B"}`
      }
      onClick={() => toggleSlot(scene.date, slot)}
      className={cn(
        "h-6 flex-1 rounded border text-[11px] font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
        active
          ? "border-accent bg-accent text-accent-fg"
          : "border-border bg-surface text-muted hover:text-text",
      )}
    >
      {slot === "dateA" ? "A" : "B"}
    </button>
  );

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <SceneCard scene={scene} />
      <div className="flex gap-1">
        {slotButton("dateA", isA)}
        {slotButton("dateB", isB)}
      </div>
    </div>
  );
}
