"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { useAppStore, type SheetKey } from "@/store/useAppStore";

/** Snap points as a fraction of the visual viewport. */
const SNAPS = [0.3, 0.6, 0.9] as const;

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Identifies this sheet in the store so map chrome can follow its height. */
  sheetKey: SheetKey;
  label: string;
  children: React.ReactNode;
  className?: string;
  /** Snap index the sheet opens at (0 = 30%, 1 = 60%, 2 = 90%). */
  initialSnap?: number;
}

/**
 * Phone bottom sheet: three snap points (30/60/90% of the visual viewport),
 * drag-to-resize on the grabber (tap cycles snaps), backdrop + Escape to
 * close. Tracks the on-screen keyboard via --vvh / --kb-inset (set by
 * ViewportSync) and stays above the bottom tab bar via --tabbar-h. Publishes
 * its measured height into the store so map controls/attribution offset.
 */
export default function BottomSheet({
  open,
  onClose,
  sheetKey,
  label,
  children,
  className,
  initialSnap = 1,
}: BottomSheetProps) {
  const [snapIndex, setSnapIndex] = useState(initialSnap);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const setSheetState = useAppStore((s) => s.setSheetState);
  const sectionRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const lastHeightRef = useRef(0);
  const didDragRef = useRef(false);

  // Publish the measured height while open; clear on close (only if this
  // sheet still owns the slot — sheets are mutually exclusive).
  useEffect(() => {
    if (!open) {
      setSheetState(sheetKey, 0);
      return;
    }
    const element = sectionRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const height = Math.round(element.getBoundingClientRect().height);
      lastHeightRef.current = height;
      setSheetState(sheetKey, height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, sheetKey, setSheetState]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const viewportHeight = (): number =>
    window.visualViewport?.height ?? window.innerHeight;

  const endDrag = (): void => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    const fraction = lastHeightRef.current / viewportHeight();
    let nearest = 0;
    for (let index = 1; index < SNAPS.length; index++) {
      if (Math.abs(SNAPS[index]! - fraction) < Math.abs(SNAPS[nearest]! - fraction)) {
        nearest = index;
      }
    }
    setSnapIndex(nearest);
    setDragHeight(null);
  };

  const heightStyle: number | string =
    dragHeight !== null
      ? dragHeight
      : `max(160px, calc(${SNAPS[snapIndex]} * var(--vvh, 100svh) - var(--kb-inset, 0px)))`;

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label={`Close ${label}`}
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/30"
        />
      )}
      <section
        ref={sectionRef}
        role="dialog"
        aria-label={label}
        aria-hidden={!open}
        className={cn(
          "fixed inset-x-0 z-50 flex flex-col overflow-hidden rounded-t-lg border-t border-border bg-surface shadow-float",
          "transition-[transform,visibility] duration-150 ease-out",
          open ? "translate-y-0" : "invisible translate-y-full",
          className,
        )}
        style={{
          bottom: "calc(var(--tabbar-h, 0px) + var(--kb-inset, 0px))",
          height: heightStyle,
        }}
      >
        {/* Grabber: drag to resize, tap to cycle snaps. */}
        <div
          aria-hidden
          className="flex shrink-0 cursor-grab touch-none select-none flex-col items-center gap-1.5 pb-1 pt-2"
          onPointerDown={(event) => {
            if (!open) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = {
              startY: event.clientY,
              startHeight:
                sectionRef.current?.getBoundingClientRect().height ?? viewportHeight() * 0.6,
            };
            didDragRef.current = false;
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            const raw = drag.startHeight - (event.clientY - drag.startY);
            const min = viewportHeight() * 0.22;
            const max = viewportHeight() * 0.94;
            const clamped = Math.min(max, Math.max(min, raw));
            if (Math.abs(clamped - drag.startHeight) > 4) didDragRef.current = true;
            lastHeightRef.current = clamped;
            setDragHeight(clamped);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onClick={() => {
            if (didDragRef.current) return;
            setSnapIndex((index) => (index + 1) % SNAPS.length);
          }}
        >
          <span className="h-1 w-9 rounded-full bg-border" />
        </div>
        {children}
      </section>
    </>
  );
}
