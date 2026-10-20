"use client";

export default function SceneSkeleton() {
  return (
    <div
      aria-hidden
      className="min-w-[240px] shrink-0 rounded border border-border bg-surface p-3"
    >
      <div className="flex gap-2">
        <div className="h-16 w-16 shrink-0 rounded-sm bg-surface-2" />
        <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
          <div className="h-3 w-20 rounded-sm bg-surface-2" />
          <div className="h-3 w-14 rounded-sm bg-surface-2" />
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-16 rounded-sm bg-surface-2" />
            <div className="h-1 w-10 rounded-full bg-surface-2" />
          </div>
          <div className="h-3 w-24 rounded-sm bg-surface-2" />
          <div className="h-3 w-28 rounded-sm bg-surface-2" />
        </div>
      </div>
    </div>
  );
}
