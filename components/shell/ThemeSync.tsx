"use client";

import { useEffect } from "react";
import { useTheme } from "@/store/useTheme";

/** Applies the persisted theme to <html data-theme>. */
export default function ThemeSync() {
  const theme = useTheme((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "dark" ? "#14151A" : "#F6F5F1");
  }, [theme]);

  return null;
}
