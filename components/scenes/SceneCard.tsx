"use client";

import { useState } from "react";
import {
  ExternalLink,
  FileImage,
  Image as ImageIcon,
  Layers,
  Loader2,
  MoreHorizontal,
  Package,
} from "lucide-react";
import { createPortal } from "react-dom";
import type { Scene } from "@/lib/data";
import { buildCopernicusBrowserUrl } from "@/lib/copernicusBrowser";
import type { DownloadFormat } from "@/lib/downloads";
import { useActiveSelection, useAppStore } from "@/store/useAppStore";
import { cn } from "@/components/ui/cn";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import ProductDialog from "@/components/scenes/ProductDialog";

interface SceneCardProps {
  scene: Scene;
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  const month = new Date(Number(y), Number(m) - 1, Number(d)).toLocaleString("en", {
    month: "short",
  });
  return `${d} ${month} ${y}`;
}

/** "05:41 UTC" — acquisition instant from the STAC datetime. */
function formatUtcTime(time: string | undefined): string | null {
  if (!time) return null;
  const parsed = new Date(time);
  if (Number.isNaN(parsed.getTime())) return null;
  const hh = String(parsed.getUTCHours()).padStart(2, "0");
  const mm = String(parsed.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

function cloudTone(cloud: number): string {
  if (cloud <= 10) return "bg-success";
  if (cloud <= 25) return "bg-warning";
  return "bg-danger";
}

export default function SceneCard({ scene }: SceneCardProps) {
  const activeSceneId = useAppStore((s) => s.activeSceneId);
  const setActiveScene = useAppStore((s) => s.setActiveScene);
  const setHoveredScene = useAppStore((s) => s.setHoveredScene);
  const selection = useActiveSelection();
  const downloadBusy = useAppStore((s) => s.downloadBusy);
  const requestDownload = useAppStore((s) => s.requestDownload);
  const [copied, setCopied] = useState(false);
  const [showProducts, setShowProducts] = useState(false);
  const active = activeSceneId === scene.id;
  const utcTime = formatUtcTime(scene.time);

  const handleDownload = (format: DownloadFormat) => {
    if (!selection || downloadBusy) return;
    requestDownload(
      scene,
      { name: selection.name, geometry: selection.geometry, bbox: selection.bbox },
      format,
    );
  };

  /** Deep link: same day + place, in a normal tab (no popup features). */
  const openCopernicusBrowser = () => {
    const bbox = selection?.bbox ?? scene.bbox;
    const url = buildCopernicusBrowserUrl({
      date: scene.date,
      composite: scene.composite,
      bbox,
    });
    const opened = window.open(url, "_blank");
    if (opened) opened.opener = null;
  };

  const copySceneId = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void navigator.clipboard
      .writeText(scene.sceneId)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      })
      .catch(() => undefined);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={() => setActiveScene(active ? null : scene.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setActiveScene(active ? null : scene.id);
        }
      }}
      onMouseEnter={() => setHoveredScene(scene.id)}
      onMouseLeave={() => setHoveredScene(null)}
      onFocus={() => setHoveredScene(scene.id)}
      onBlur={() => setHoveredScene(null)}
      className={cn(
        "relative min-w-[240px] shrink-0 cursor-pointer rounded border bg-surface p-3 text-left transition-colors duration-150",
        active ? "border-2 border-accent" : "border-border hover:bg-surface-2",
      )}
    >
      <div className="flex gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- data-URI catalogue thumbnail */}
        <img
          src={scene.thumbnail}
          alt=""
          width={64}
          height={64}
          className="h-16 w-16 shrink-0 rounded-sm border border-border object-cover"
        />
        <div className="min-w-0 flex-1">
          <p
            className="mono-nums truncate pr-6 text-xs text-text"
            title={scene.platformCode ? `${scene.satellite} (${scene.platformCode})` : scene.satellite}
          >
            {formatDate(scene.date)}
          </p>
          <p className="mono-nums truncate text-xs text-muted">
            {utcTime ?? scene.satellite}
          </p>
          <div className="mt-1 flex items-center gap-1.5" title={`${scene.cloudCover.toFixed(1)}% cloud`}>
            <span className="mono-nums truncate text-xs text-muted">
              Cloud {scene.cloudCover.toFixed(1)}%
            </span>
            <span className="h-1 w-10 shrink-0 overflow-hidden rounded-full bg-border">
              <span
                className={cn("block h-full rounded-full", cloudTone(scene.cloudCover))}
                style={{ width: `${Math.max(2, Math.min(100, scene.cloudCover))}%` }}
              />
            </span>
          </div>
          {typeof scene.coverage === "number" && (
            <p
              className={cn(
                "mono-nums mt-0.5 truncate text-[11px]",
                scene.coverage >= 90 ? "text-muted" : "text-warning",
              )}
            >
              {scene.coverage}% coverage
              {scene.coverage < 90 && (
                <span className="ml-1 rounded-sm border border-border bg-surface-2 px-1 py-px text-[10px] text-muted">
                  Partial coverage
                </span>
              )}
            </p>
          )}
          <button
            type="button"
            onClick={copySceneId}
            onKeyDown={(event) => event.stopPropagation()}
            title={copied ? "Copied" : `${scene.sceneId} — click to copy`}
            className={cn(
              "mono-nums mt-1 block w-full truncate rounded-sm text-left text-[11px] transition-colors duration-150",
              copied ? "text-accent" : "text-muted hover:text-text",
            )}
          >
            {copied ? "Copied" : scene.sceneId}
          </button>
        </div>
      </div>

      {/* Download menu — stopPropagation so it doesn't toggle the scene. */}
      <div className="absolute right-1 top-1" onClick={(event) => event.stopPropagation()}>
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              aria-label={`Scene actions for ${scene.date}`}
              className="grid h-6 w-6 place-items-center rounded text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text"
            >
              {downloadBusy ? (
                <Loader2 size={13} className="animate-spin" aria-hidden />
              ) : (
                <MoreHorizontal size={14} />
              )}
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="min-w-[15rem]">
            <MenuLabel>Download</MenuLabel>
            <MenuItem
              disabled={!selection || downloadBusy !== null}
              title="8-bit RGBA render for a quick look — not for analysis."
              onSelect={() => handleDownload("png")}
            >
              <FileImage size={14} />
              {downloadBusy === "png" ? "Preparing…" : "Preview image (PNG)"}
            </MenuItem>
            <MenuItem
              disabled={!selection || downloadBusy !== null}
              title="Georeferenced 8-bit RGB, opens correctly in QGIS."
              onSelect={() => handleDownload("tiff")}
            >
              <ImageIcon size={14} />
              {downloadBusy === "tiff" ? "Preparing…" : "GeoTIFF, visual (8-bit RGB)"}
            </MenuItem>
            <MenuItem
              disabled={!selection || downloadBusy !== null}
              title="8 float32 bands: B02, B03, B04, B08, B11, B12, NDVI, SCL."
              onSelect={() => handleDownload("analysis")}
            >
              <Layers size={14} />
              {downloadBusy === "analysis" ? "Preparing…" : "GeoTIFF, analysis (multi-band)"}
            </MenuItem>
            {!selection && (
              <>
                <MenuSeparator />
                <p className="px-2 py-1 text-[11px] text-muted">Select an area first</p>
              </>
            )}
            <MenuSeparator />
            <MenuItem title={`Opens ${scene.date} in a new tab`} onSelect={openCopernicusBrowser}>
              <ExternalLink size={14} />
              Open in Copernicus Browser
            </MenuItem>
            <MenuItem
              title="Original Sentinel-2 catalogue ids for the .SAFE ZIP"
              onSelect={() => setShowProducts(true)}
            >
              <Package size={14} />
              Full product (.SAFE ZIP)
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {showProducts &&
        createPortal(<ProductDialog scene={scene} onClose={() => setShowProducts(false)} />, document.body)}
    </div>
  );
}
