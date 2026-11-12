"use client";

import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

export const useIsDesktop = (): boolean => useMediaQuery("(min-width: 1024px)");

/**
 * Layout form factor:
 *   phone  — <768px: bottom tab bar + snap-point bottom sheets
 *   tablet — 768–1023px: overlay side drawers (panel left, results right)
 *   desktop — ≥1024px: rail + docked panels (original layout)
 */
export type FormFactor = "phone" | "tablet" | "desktop";

export function useFormFactor(): FormFactor {
  const phone = useMediaQuery("(max-width: 767px)");
  const desktop = useMediaQuery("(min-width: 1024px)");
  if (desktop) return "desktop";
  if (phone) return "phone";
  return "tablet";
}
