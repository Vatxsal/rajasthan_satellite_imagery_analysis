"use client";

import MapCanvas from "@/components/map/MapCanvas";
import Panel from "@/components/shell/Panel";
import Rail from "@/components/shell/Rail";
import TopBar from "@/components/shell/TopBar";
import SceneStrip from "@/components/scenes/SceneStrip";
import CompareDrawer from "@/components/compare/CompareDrawer";
import CompareMapController from "@/components/compare/CompareMapController";
import FieldsMapController from "@/components/fields/FieldsMapController";
import DownloadDialog from "@/components/scenes/DownloadDialog";
import ShareLinkLoader from "@/components/ShareLinkLoader";
import ToastStack from "@/components/ui/ToastStack";
import { useIsDesktop } from "@/lib/hooks/useMediaQuery";

export default function Page() {
  const isDesktop = useIsDesktop();

  return (
    <div className="flex h-dvh flex-col bg-bg text-text">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <Rail />
        <Panel />
        <main className="relative min-h-0 min-w-0 flex-1">
          <MapCanvas />
          <CompareMapController />
          <FieldsMapController />
          {isDesktop && <SceneStrip />}
        </main>
        {/* Desktop: resizable right-hand results panel (map keeps the majority of the viewport). */}
        {isDesktop && <CompareDrawer />}
      </div>
      {/* Mobile: fixed bottom sheet above the map. */}
      {!isDesktop && <CompareDrawer />}
      <ToastStack />
      <DownloadDialog />
      {/* Renders null: reopens an emailed report from ?a=&l=&A=&B=… links. */}
      <ShareLinkLoader />
    </div>
  );
}
