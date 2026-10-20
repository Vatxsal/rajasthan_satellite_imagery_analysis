"use client";

import type { ReactNode } from "react";
import { cn } from "./cn";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-border",
  accent: "bg-accent-soft text-accent border-transparent",
  success: "bg-surface-2 text-success border-border",
  warning: "bg-surface-2 text-warning border-border",
  danger: "bg-surface-2 text-danger border-border",
};

export interface ChipProps {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}

export default function Chip({ children, tone = "neutral", className }: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
