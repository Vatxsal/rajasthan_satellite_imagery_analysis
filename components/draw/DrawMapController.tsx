"use client";

import { useEffect } from "react";
import { getMainMap } from "@/lib/compare/bridge";
import { bindDrawMap } from "@/lib/draw/mapBridge";
import { useDrawStore } from "@/store/useDrawStore";

/**
 * Binds Terra Draw to the main map. Re-runs when the tool changes so the
 * first tool click after map load both binds and arms drawing (the bridge
 * applies the current store tool on bind); later clicks go straight to the
 * runtime the bridge installed.
 */
export default function DrawMapController() {
  const tool = useDrawStore((s) => s.tool);

  useEffect(() => {
    const map = getMainMap();
    if (!map) return;
    try {
      bindDrawMap(map);
    } catch {
      // Map disposed mid-bind.
    }
  }, [tool]);

  return null;
}
