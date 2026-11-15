"use client";

import { useEffect } from "react";
import { useTheme } from "@/store/useTheme";
import { usePreferencesStore } from "@/store/usePreferencesStore";

/**
 * Applies persisted UI state to <html>: the theme (data-theme + theme-color
 * meta) and the appearance preferences — text size as the root font size
 * (every Tailwind rem follows) and reduce animations as data-reduce-animations
 * (globals.css honours it, "system" defers to the OS media query).
 */
export default function ThemeSync() {
  const theme = useTheme((s) => s.theme);
  const textSize = usePreferencesStore((s) => s.values.appearance.textSize);
  const reduceAnimations = usePreferencesStore((s) => s.values.appearance.reduceAnimations);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#14151A" : "#F6F5F1");
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.fontSize = textSize === "100" ? "" : `${(Number(textSize) / 100) * 16}px`;
    root.dataset.reduceAnimations = reduceAnimations;
  }, [textSize, reduceAnimations]);

  return null;
}
