"use client";

import { useAppStore, type SheetKey } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";

/**
 * Sheet exclusivity. Phone (<768px): exactly one bottom sheet among
 * panel / results / compare. Tablet (768–1023px): the panel drawer (left) is
 * independent, while results and compare share the right-hand drawer slot.
 * Desktop never calls these helpers.
 */
function isPhone(): boolean {
  return window.matchMedia("(max-width: 767px)").matches;
}

export function openSheet(which: SheetKey): void {
  const phone = isPhone();
  if (which === "compare") {
    // Right slot: results must go; the left panel drawer may stay on tablet.
    useAppStore.setState(phone ? { sidebarOpen: false, resultsOpen: false } : { resultsOpen: false });
    useCompareStore.getState().setDrawerOpen(true);
    return;
  }
  if (which === "results") {
    useAppStore.setState({ resultsOpen: true, ...(phone ? { sidebarOpen: false } : {}) });
    useCompareStore.getState().setDrawerOpen(false);
    return;
  }
  // panel (left slot — independent of the right slot on tablet)
  useAppStore.setState({
    sidebarOpen: true,
    sidebarCollapsed: false,
    ...(phone ? { resultsOpen: false } : {}),
  });
  if (phone) useCompareStore.getState().setDrawerOpen(false);
}

export function closeSheets(): void {
  useCompareStore.getState().setDrawerOpen(false);
  useAppStore.setState({ sidebarOpen: false, resultsOpen: false });
}

/** Tab-bar / hamburger behaviour: second tap on the active sheet closes it. */
export function toggleSheet(which: SheetKey): void {
  const app = useAppStore.getState();
  const compare = useCompareStore.getState();
  const open =
    which === "compare"
      ? compare.drawerOpen
      : which === "results"
        ? app.resultsOpen
        : app.sidebarOpen;
  if (open) closeSheets();
  else openSheet(which);
}

/** Hamburger: opens (or closes) the panel sheet/drawer without touching others on tablet. */
export function togglePanelSheet(): void {
  const app = useAppStore.getState();
  if (app.sidebarOpen) {
    useAppStore.setState({ sidebarOpen: false });
    return;
  }
  openSheet("panel");
}
