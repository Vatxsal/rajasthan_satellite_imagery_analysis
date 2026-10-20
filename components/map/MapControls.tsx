"use client";

import { Camera, Crosshair, Home, Maximize2, Minus, MoreHorizontal, Plus } from "lucide-react";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/Menu";

interface MapControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onHome: () => void;
  onLocate: () => void;
  onFullscreen: () => void;
  onScreenshot: () => void;
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-8 w-8 place-items-center rounded border border-border bg-surface text-text shadow-float transition-colors duration-150 hover:bg-surface-2"
    >
      {children}
    </button>
  );
}

export default function MapControls({
  onZoomIn,
  onZoomOut,
  onHome,
  onLocate,
  onFullscreen,
  onScreenshot,
}: MapControlsProps) {
  return (
    <div className="absolute right-3 top-3 z-20 flex flex-col gap-1.5">
      <div className="flex flex-col gap-1 overflow-hidden rounded border border-border bg-surface shadow-float">
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          onClick={onZoomIn}
          className="grid h-8 w-8 place-items-center border-b border-border text-text transition-colors duration-150 hover:bg-surface-2"
        >
          <Plus size={15} />
        </button>
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          onClick={onZoomOut}
          className="grid h-8 w-8 place-items-center text-text transition-colors duration-150 hover:bg-surface-2"
        >
          <Minus size={15} />
        </button>
      </div>

      <ControlButton label="Reset to Rajasthan" onClick={onHome}>
        <Home size={15} />
      </ControlButton>
      <ControlButton label="Locate me" onClick={onLocate}>
        <Crosshair size={15} />
      </ControlButton>
      <ControlButton label="Fullscreen" onClick={onFullscreen}>
        <Maximize2 size={15} />
      </ControlButton>

      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            title="More actions"
            aria-label="More actions"
            className="grid h-8 w-8 place-items-center rounded border border-border bg-surface text-text shadow-float transition-colors duration-150 hover:bg-surface-2"
          >
            <MoreHorizontal size={15} />
          </button>
        </MenuTrigger>
        <MenuContent align="end">
          <MenuItem onSelect={onScreenshot}>
            <Camera size={14} />
            Download screenshot
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
