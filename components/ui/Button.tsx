"use client";

import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "icon";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-accent text-accent-fg border border-accent hover:opacity-90 disabled:opacity-50",
  secondary:
    "bg-surface text-text border border-border hover:bg-surface-2",
  ghost: "bg-transparent text-muted border border-transparent hover:bg-surface-2 hover:text-text",
  danger: "bg-surface text-danger border border-border hover:bg-surface-2",
};

const sizeClasses: Record<Size, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-9 px-3.5 text-sm",
  icon: "h-8 w-8 p-0",
};

export default function Button({
  variant = "secondary",
  size = "sm",
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded font-medium transition-colors duration-150",
        "disabled:cursor-not-allowed",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    />
  );
}
