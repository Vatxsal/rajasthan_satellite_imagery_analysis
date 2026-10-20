"use client";

import { useEffect, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import Legend from "@/components/layers/Legend";
import { cn } from "@/components/ui/cn";

export default function LegendControl() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickAway = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClickAway);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClickAway);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-52 rounded-lg border border-border bg-surface p-2.5">
          <Legend />
        </div>
      )}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded border border-border bg-surface px-2.5 text-xs shadow-float transition-colors duration-150",
          open ? "text-accent" : "text-muted hover:text-text",
        )}
      >
        <BookOpen size={13} />
        Legend
      </button>
    </div>
  );
}
