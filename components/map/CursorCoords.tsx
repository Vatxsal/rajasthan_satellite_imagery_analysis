"use client";

import { useEffect, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { cn } from "@/components/ui/cn";

interface CursorCoordsProps {
  mapRef: React.MutableRefObject<MapLibreMap | null>;
  className?: string;
  style?: React.CSSProperties;
}

export default function CursorCoords({ mapRef, className, style }: CursorCoordsProps) {
  const [coords, setCoords] = useState<[number, number] | null>(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let frame = 0;
    const onMove = (event: { lngLat: { lng: number; lat: number } }) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setCoords([event.lngLat.lng, event.lngLat.lat]);
      });
    };
    const onLeave = () => setCoords(null);

    map.on("mousemove", onMove);
    map.on("mouseout", onLeave);
    return () => {
      cancelAnimationFrame(frame);
      map.off("mousemove", onMove);
      map.off("mouseout", onLeave);
    };
  }, [mapRef]);

  return (
    <div className={cn("z-10", className)} style={style} aria-live="polite">
      <span className="mono-nums rounded border border-border bg-surface/90 px-2 py-1 text-[11px] text-muted">
        {coords
          ? `${coords[1].toFixed(4)}° N  ${coords[0].toFixed(4)}° E`
          : "—.————° N  —.————° E"}
      </span>
    </div>
  );
}
