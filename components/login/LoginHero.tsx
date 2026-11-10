"use client";

/**
 * Left column of /login: brand, headline with rotating phrases, value
 * points, the animated Rajasthan district outline (server-computed path),
 * animated counters, and the "how it works" strip. Motion is CSS-only and
 * fully disabled under prefers-reduced-motion; the rotating phrase pauses
 * on hover/focus.
 */
import { useEffect, useState } from "react";
import { Languages, Mail, Map, Satellite } from "lucide-react";

export interface DistrictMarker {
  name: string;
  x: number;
  y: number;
}

const PHRASES = [
  "Track water bodies.",
  "Spot new construction.",
  "Watch crops turn.",
  "Compare any two dates.",
];

const VALUE_POINTS = [
  { icon: Satellite, text: "10 m detail, every ~5 days" },
  { icon: Map, text: "33 districts, 224 tehsils" },
  { icon: Languages, text: "Hindi and English AI summaries" },
  { icon: Mail, text: "Report in your inbox in one click" },
];

const STEPS = ["Pick an area", "Compare two dates", "Get the report"];

interface CounterSpec {
  value: number;
  suffix?: string;
  label: string;
}

const COUNTERS: CounterSpec[] = [
  { value: 33, label: "Districts" },
  { value: 224, label: "Tehsils" },
  { value: 10, suffix: " m", label: "Ground detail" },
  { value: 5, suffix: " d", label: "Revisit" },
];

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function Counter({ value, suffix, label }: CounterSpec) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(value);
      return;
    }
    const durationMs = 1_400;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(value * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <div className="flex flex-col gap-0.5">
      <span className="rse-counter mono-nums text-xl font-semibold text-text">
        {display}
        {suffix ?? ""}
      </span>
      <span className="text-[11px] uppercase tracking-[0.08em] text-muted">{label}</span>
    </div>
  );
}

interface LoginHeroProps {
  districtsPath: string;
  mapWidth: number;
  mapHeight: number;
  markers: DistrictMarker[];
}

export default function LoginHero({
  districtsPath,
  mapWidth,
  mapHeight,
  markers,
}: LoginHeroProps) {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(prefersReducedMotion());
  }, []);

  useEffect(() => {
    if (reduced || paused) return;
    const id = window.setInterval(() => {
      setPhraseIndex((current) => (current + 1) % PHRASES.length);
    }, 3_200);
    return () => window.clearInterval(id);
  }, [reduced, paused]);

  return (
    <div className="flex min-w-0 flex-1 flex-col justify-between gap-8 px-5 py-8 lg:px-12 lg:py-10">
      {/* Brand */}
      <div className="rse-rise flex items-center gap-2.5" style={{ animationDelay: "0ms" }}>
        <span
          aria-hidden
          className="grid h-8 w-8 place-items-center rounded bg-accent text-sm font-bold text-accent-fg"
        >
          RE
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-text">Rajasthan Imagery Explorer</p>
          <p className="text-[11px] uppercase tracking-[0.1em] text-muted">
            Satellite change intelligence
          </p>
        </div>
      </div>

      {/* Headline + phrase */}
      <div
        className="rse-rise flex flex-col gap-4"
        style={{ animationDelay: "90ms" }}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        <h1 className="max-w-[16ch] text-3xl font-semibold leading-[1.15] tracking-tight text-text sm:text-4xl lg:text-[44px]">
          See Rajasthan change, from space.
        </h1>
        <p className="min-h-[1.6em] text-lg font-medium text-accent sm:text-xl">
          <span key={reduced ? 0 : phraseIndex} className={reduced ? undefined : "rse-phrase-in"}>
            {reduced ? PHRASES[0] : PHRASES[phraseIndex]}
          </span>
        </p>
        <p className="max-w-[46ch] text-sm leading-6 text-muted">
          Compare any two dates across the state at 10 m detail — and get a clear, AI-written
          change report delivered to your inbox.
        </p>
      </div>

      {/* Value points */}
      <ul
        className="rse-rise grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2"
        style={{ animationDelay: "180ms" }}
      >
        {VALUE_POINTS.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-2.5 text-sm text-text">
            <span className="grid h-7 w-7 shrink-0 place-items-center rounded border border-border bg-surface">
              <Icon size={14} className="text-accent" aria-hidden />
            </span>
            {text}
          </li>
        ))}
      </ul>

      {/* District outline map */}
      <div
        className="rse-rise relative mx-auto w-full max-w-[560px] overflow-hidden rounded-lg border border-border bg-surface p-3"
        style={{ animationDelay: "260ms" }}
      >
        <svg
          viewBox={`0 0 ${mapWidth} ${mapHeight}`}
          className="block h-auto w-full"
          role="img"
          aria-label="Outline map of Rajasthan with district boundaries"
        >
          <path className="rse-map-fill" d={districtsPath} fill="rgb(var(--accent-soft))" />
          <path
            className="rse-map-line"
            d={districtsPath}
            pathLength={1}
            fill="none"
            stroke="rgb(var(--accent))"
            strokeWidth={1.4}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.85}
          />
          {markers.map((marker) => (
            <g key={marker.name}>
              <circle
                className="rse-marker-pulse"
                cx={marker.x}
                cy={marker.y}
                r={18}
                fill="rgb(var(--accent))"
                opacity={0.35}
              />
              <circle cx={marker.x} cy={marker.y} r={6.5} fill="rgb(var(--accent))" />
              <text
                x={marker.x}
                y={marker.y - 15}
                textAnchor="middle"
                fontSize={20}
                fontWeight={600}
                fill="rgb(var(--text))"
              >
                {marker.name}
              </text>
            </g>
          ))}
        </svg>
        {/* Scan-line sweep over the map (CSS-only). */}
        <span aria-hidden className="rse-scan pointer-events-none absolute inset-x-0 h-px bg-accent/70" />
      </div>

      {/* Counters */}
      <div
        className="rse-rise grid grid-cols-2 gap-4 border-t border-border pt-5 sm:grid-cols-4"
        style={{ animationDelay: "340ms" }}
      >
        {COUNTERS.map((counter) => (
          <Counter key={counter.label} {...counter} />
        ))}
      </div>

      {/* How it works */}
      <div className="rse-rise" style={{ animationDelay: "420ms" }}>
        <p className="section-label mb-3">How it works</p>
        <ol className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          {STEPS.map((step, index) => (
            <li key={step} className="flex items-center gap-2 text-sm text-text">
              <span className="mono-nums grid h-6 w-6 shrink-0 place-items-center rounded-full border border-accent text-[11px] font-semibold text-accent">
                {index + 1}
              </span>
              {step}
              {index < STEPS.length - 1 && (
                <span aria-hidden className="hidden text-muted sm:inline">
                  →
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
