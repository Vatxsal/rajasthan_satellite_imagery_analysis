"use client";

/**
 * Full-bleed before/after Sentinel-2 swipe for /login. The "after" frame is
 * the base image; the "before" frame is clipped to `--rse-swipe`, which
 * sweeps once on load (CSS) until the first pointer/key interaction takes
 * over. Cartographic furniture (graticule ticks, scale bar, north mark,
 * date chips) is aligned to the image's cover-cropped box via a measured
 * ResizeObserver — no animation library, pointer/touch/keyboard drag.
 */
import { useEffect, useRef, useState } from "react";
import { MoveHorizontal } from "lucide-react";
import { cn } from "@/components/ui/cn";

interface LandingSwipeProps {
  className?: string;
  beforeSrc: string;
  afterSrc: string;
  beforeLabel: string;
  afterLabel: string;
  site: string;
  bbox: [number, number, number, number];
  imageWidth: number;
  imageHeight: number;
  scaleKm: number;
  scalePercent: number;
}

/** Graticule ticks inside the bbox, at `step` degree spacing. */
function ticks(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const epsilon = 1e-9;
  for (let value = Math.ceil(min / step) * step; value <= max + epsilon; value += step) {
    const rounded = Math.round(value * 100) / 100;
    if (rounded > min + epsilon && rounded < max - epsilon) out.push(rounded);
  }
  return out;
}

export default function LandingSwipe({
  className,
  beforeSrc,
  afterSrc,
  beforeLabel,
  afterLabel,
  site,
  bbox,
  imageWidth,
  imageHeight,
  scaleKm,
  scalePercent,
}: LandingSwipeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [divider, setDivider] = useState(50);
  const [touched, setTouched] = useState(false);

  // Cover-crop measurement: furniture must sit on the same pixels the
  // object-cover <img> actually shows, so the wrapper matches the cover box.
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setBox({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const markTouched = (): void => setTouched(true);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    markTouched();
    const rect = root.getBoundingClientRect();
    const moveTo = (clientX: number): void => {
      const pct = ((clientX - rect.left) / Math.max(1, rect.width)) * 100;
      setDivider(Math.min(100, Math.max(0, pct)));
    };
    moveTo(event.clientX);
    const onMove = (moveEvent: PointerEvent): void => moveTo(moveEvent.clientX);
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      event.preventDefault();
      markTouched();
      setDivider((value) => Math.max(0, value - step));
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      event.preventDefault();
      markTouched();
      setDivider((value) => Math.min(100, value + step));
    } else if (event.key === "Home") {
      event.preventDefault();
      markTouched();
      setDivider(0);
    } else if (event.key === "End") {
      event.preventDefault();
      markTouched();
      setDivider(100);
    }
  };

  // Furniture alignment: cover box for the image inside the measured root.
  const ratio = imageWidth / Math.max(1, imageHeight);
  const coverW = box.width > 0 ? Math.max(box.width, box.height * ratio) : 0;
  const coverH = box.height > 0 ? Math.max(box.height, box.width / ratio) : 0;

  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonTicks = ticks(minLon, maxLon, 0.1);
  const latTicks = ticks(minLat, maxLat, 0.1);
  const xPct = (lon: number): number => ((lon - minLon) / (maxLon - minLon)) * 100;
  const yPct = (lat: number): number => ((maxLat - lat) / (maxLat - minLat)) * 100;

  return (
    <div
      ref={rootRef}
      className={cn("rse-swipe", touched && "rse-touched", className)}
      style={{ "--rse-swipe": `${divider}%` } as React.CSSProperties}
    >
      {/* Base: post-monsoon frame. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- pre-optimized AVIF, LCP */}
      <img
        src={afterSrc}
        alt={`${site}, ${afterLabel} — Sentinel-2 after the monsoon`}
        className="absolute inset-0 h-full w-full object-cover"
        loading="eager"
        decoding="async"
        fetchPriority="high"
        draggable={false}
      />
      {/* Clipped layer: pre-monsoon frame. */}
      <div
        className="absolute inset-0 z-[1] overflow-hidden"
        style={{ clipPath: "inset(0 calc(100% - var(--rse-swipe)) 0 0)" }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- pre-optimized AVIF */}
        <img
          src={beforeSrc}
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
          loading="eager"
          decoding="async"
          draggable={false}
        />
      </div>

      {/* Graticule + scale bar, aligned to the cover-cropped image box. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-1/2 z-[2] -translate-x-1/2 -translate-y-1/2"
        style={
          coverW > 0
            ? { width: coverW, height: coverH }
            : { inset: 0, transform: "none" }
        }
      >
        {lonTicks.map((lon, index) => (
          <span key={`lon-${lon}`}>
            <span
              className="rse-tick absolute top-1.5 h-4 w-px origin-top bg-surface/85"
              style={{ left: `${xPct(lon)}%`, animationDelay: `${500 + index * 60}ms` }}
            />
            <span
              className="rse-tick absolute top-6 -translate-x-1/2 whitespace-nowrap rounded-[2px] bg-surface/85 px-1 font-mono text-[11px] leading-4 text-text"
              style={{ left: `${xPct(lon)}%`, animationDelay: `${540 + index * 60}ms` }}
            >
              {lon.toFixed(1)}°E
            </span>
          </span>
        ))}
        {latTicks.map((lat, index) => (
          <span key={`lat-${lat}`}>
            <span
              className="rse-tick absolute left-1.5 h-px w-4 origin-left bg-surface/85"
              style={{ top: `${yPct(lat)}%`, animationDelay: `${560 + index * 60}ms` }}
            />
            <span
              className="rse-tick absolute left-6 -translate-y-1/2 whitespace-nowrap rounded-[2px] bg-surface/85 px-1 font-mono text-[11px] leading-4 text-text"
              style={{ top: `${yPct(lat)}%`, animationDelay: `${600 + index * 60}ms` }}
            >
              {lat.toFixed(1)}°N
            </span>
          </span>
        ))}
      </div>

      {/* Scale bar — anchored above the paper-band overlap; width is the
          cover-box share of the bbox-derived ground distance. */}
      <span
        aria-hidden
        className="rse-tick absolute bottom-16 left-4 z-[3] flex flex-col"
        style={{
          width: coverW > 0 ? (coverW * scalePercent) / 100 : `${scalePercent}%`,
          animationDelay: "900ms",
        }}
      >
        <span className="block h-1.5 w-full border border-b-0 border-surface bg-surface/85" />
        <span className="mt-0.5 whitespace-nowrap rounded-[2px] bg-surface/85 px-1 font-mono text-[11px] leading-4 text-text">
          {scaleKm} km
        </span>
      </span>

      {/* Masthead + north mark (container-anchored). */}
      <span className="rse-rise absolute left-3 top-3 z-[3] rounded-[2px] border border-border bg-surface/90 px-2 py-1 text-[11px] font-semibold leading-4 text-text shadow-float">
        {site}
      </span>
      <span
        aria-hidden
        className="rse-rise absolute right-3 top-3 z-[3] flex flex-col items-center rounded-[2px] border border-border bg-surface/90 px-1.5 py-1 text-text shadow-float"
        style={{ animationDelay: "80ms" }}
      >
        <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden>
          <path d="M6 1 L9.5 12 L6 9.5 L2.5 12 Z" fill="currentColor" />
        </svg>
        <span className="font-mono text-[10px] font-semibold leading-3">N</span>
      </span>

      {/* Date chips track the divider. */}
      <span
        className="mono-nums absolute top-8 z-[3] -translate-x-full rounded-[2px] border border-border bg-surface/90 px-1.5 py-0.5 text-[11px] leading-4 text-text shadow-float"
        style={{ left: "var(--rse-swipe)", paddingRight: "0.5rem" }}
      >
        {beforeLabel}
      </span>
      <span
        className="mono-nums absolute top-8 z-[3] rounded-[2px] border border-border bg-surface/90 px-1.5 py-0.5 text-[11px] leading-4 text-text shadow-float"
        style={{ left: "var(--rse-swipe)", paddingLeft: "0.5rem" }}
      >
        {afterLabel}
      </span>

      {/* Divider handle — pointer, touch and keyboard (CompareMapController pattern). */}
      <div
        role="slider"
        tabIndex={0}
        aria-label={`Comparison divider between ${beforeLabel} and ${afterLabel} imagery of ${site}`}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(divider)}
        aria-valuetext={`${Math.round(divider)}% — ${beforeLabel} on the left, ${afterLabel} on the right`}
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
        className="absolute bottom-0 top-0 z-[4] -ml-[22px] w-11 cursor-ew-resize touch-none"
        style={{ left: "var(--rse-swipe)" }}
      >
        <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-accent shadow-float" />
        <span className="absolute left-1/2 top-1/2 grid h-10 w-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-border bg-surface text-text shadow-float max-lg:h-12 max-lg:w-12">
          <MoveHorizontal size={16} aria-hidden />
        </span>
      </div>
    </div>
  );
}
