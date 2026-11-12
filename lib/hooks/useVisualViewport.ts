"use client";

import { useEffect } from "react";

/**
 * Keeps two CSS custom properties on <html> in sync with the visual viewport
 * so bottom sheets and dialogs can track the on-screen keyboard:
 *
 *   --vvh      visual viewport height in px (CSS falls back to 100svh)
 *   --kb-inset keyboard overlay height in px (layout − visual − offsetTop)
 *
 * Also keeps a focused form field visible: when the keyboard would cover it,
 * the field is scrolled into view after the keyboard animation settles.
 * Page zoom is never disabled — pinch-zoom stays available everywhere.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const root = document.documentElement;

    const update = () => {
      const vv = window.visualViewport;
      if (!vv) return;
      const inset = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
      root.style.setProperty("--kb-inset", `${inset}px`);
    };

    update();
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);

    // A focused field must never hide under the keyboard (iOS settles its
    // keyboard animation late, so retry once after the first attempt).
    const focusin = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
      if (target instanceof HTMLInputElement && target.type === "hidden") return;
      const attempt = () => {
        const vv = window.visualViewport;
        if (!vv) return;
        const rect = target.getBoundingClientRect();
        const visibleBottom = vv.offsetTop + vv.height;
        if (rect.bottom > visibleBottom - 8 || rect.top < vv.offsetTop) {
          target.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      };
      window.setTimeout(attempt, 250);
      window.setTimeout(attempt, 650);
    };
    document.addEventListener("focusin", focusin);

    return () => {
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", focusin);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--kb-inset");
    };
  }, []);
}
