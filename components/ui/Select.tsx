"use client";

import { ChevronDown } from "lucide-react";
import type { SelectHTMLAttributes } from "react";
import { cn } from "./cn";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  placeholder?: string;
}

export default function Select({
  className,
  placeholder,
  children,
  ...props
}: SelectProps) {
  return (
    <div className="relative">
      <select
        className={cn(
          "h-8 w-full appearance-none rounded border border-border bg-surface px-2.5 pr-8 text-sm text-text",
          "transition-colors duration-150 hover:border-muted focus-visible:outline-2",
          "disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted",
          className,
        )}
        {...props}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {children}
      </select>
      <ChevronDown
        size={14}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted"
      />
    </div>
  );
}
