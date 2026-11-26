"use client";

import { cn } from "./cn";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  /** Optional id for the group wrapper (label htmlFor target). */
  id?: string;
  className?: string;
  /** Fill the parent's width (default, panel/dialog rows). false → shrink to
   *  content for inline rows (the compare bar's detail picker) — without this
   *  an inline row overflows instead of wrapping. */
  fill?: boolean;
}

export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  id,
  className,
  fill = true,
}: SegmentedProps<T>) {
  return (
    <div
      role="group"
      id={id}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex rounded border border-border bg-surface-2 p-0.5",
        fill ? "w-full" : "w-auto shrink",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-w-0 flex-1 rounded-sm px-2 py-1.5 text-sm transition-colors duration-150",
              selected
                ? "border border-border bg-surface font-medium text-text"
                : "border border-transparent text-muted hover:text-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
