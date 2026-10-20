"use client";

import type { InputHTMLAttributes } from "react";
import { cn } from "./cn";

export interface SliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
}

export default function Slider({ className, ...props }: SliderProps) {
  return <input type="range" className={cn("w-full", className)} {...props} />;
}
