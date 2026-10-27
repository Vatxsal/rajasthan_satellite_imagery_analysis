"use client";

import MapCanvas from "@/components/map/MapCanvas";
import Panel from "@/components/shell/Panel";
import Rail from "@/components/shell/Rail";
import TopBar from "@/components/shell/TopBar";
import SceneStrip from "@/components/scenes/SceneStrip";
import CompareDrawer from "@/components/compare/CompareDrawer";
import CompareMapController from "@/components/compare/CompareMapController";
import DownloadDialog from "@/components/scenes/DownloadDialog";
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
          {isDesktop && <SceneStrip />}
          <CompareDrawer />
        </main>
      </div>
      <ToastStack />
      <DownloadDialog />
    </div>
  );
}
