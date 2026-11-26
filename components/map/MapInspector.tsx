"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Clipboard, ExternalLink, MapPin, Search, X } from "lucide-react";
import type { Map as MapLibreMap } from "maplibre-gl";
import BottomSheet from "@/components/ui/BottomSheet";
import Button from "@/components/ui/Button";
import { classColor, type Sensitivity } from "@/lib/analysis/config";
import type { ProbeResult } from "@/lib/analysis/probe";
import { buildCopernicusBrowserUrl } from "@/lib/copernicusBrowser";
import { patternClassLabel } from "@/lib/fields/colors";
import { formatArea, formatCoords } from "@/lib/format";
import { useFormFactor } from "@/lib/hooks/useMediaQuery";
import { OSM_ATTRIBUTION } from "@/lib/map/constants";
import { useActiveScene, useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";
import { patternById, useFieldsStore } from "@/store/useFieldsStore";
import { useInspectorStore } from "@/store/useInspectorStore";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useLocked, useQuotaToday } from "@/store/useSession";

/**
 * The unified map inspector card (Phase 1): exactly one card for every map
 * click — empty spot, fields parcel, change event — plus the keyboard path
 * via the "Inspect map centre" control. Phone renders it as the shared
 * bottom sheet (`sheetKey="inspector"`); tablet/desktop anchor it next to
 * the projected pin and follow the map's move/resize.
 *
 * Sections appear only when their data exists: Location always (local PIP +
 * basemap words), Field when a parcels polygon was clicked, Change while a
 * comparison result exists, Imagery when an active scene can be sampled.
 */

interface MapInspectorProps {
  mapRef: React.RefObject<MapLibreMap | null>;
}

export default function MapInspector({ mapRef }: MapInspectorProps) {
  const factor = useFormFactor();
  const open = useInspectorStore((s) => s.open);
  const close = useInspectorStore((s) => s.close);

  // Escape closes the desktop card (the phone sheet binds Escape itself).
  useEffect(() => {
    if (!open || factor === "phone") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, factor, close]);

  if (factor === "phone") return <InspectorSheet />;
  return <InspectorPopup mapRef={mapRef} />;
}

/* ------------------------------------------------------------- phone sheet */

function InspectorSheet() {
  const open = useInspectorStore((s) => s.open);
  const close = useInspectorStore((s) => s.close);

  // One sheet at a time: opening the inspector retires the others.
  useEffect(() => {
    if (!open) return;
    useAppStore.setState({ sidebarOpen: false, resultsOpen: false });
    useCompareStore.getState().setDrawerOpen(false);
  }, [open]);

  return (
    <BottomSheet open={open} onClose={close} sheetKey="inspector" label="Map inspector">
      <InspectorBody onClose={close} header />
    </BottomSheet>
  );
}

/* --------------------------------------------------- desktop/tablet popup */

function InspectorPopup({ mapRef }: MapInspectorProps) {
  const open = useInspectorStore((s) => s.open);
  const pin = useInspectorStore((s) => s.pin);
  const close = useInspectorStore((s) => s.close);
  const changeStatus = useInspectorStore((s) => s.change.status);
  const sampleStatus = useInspectorStore((s) => s.sample.status);
  const lookupStatus = useInspectorStore((s) => s.lookup.status);
  const hit = useInspectorStore((s) => s.hit);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<{ left: number; top: number; x: number; y: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!open || !pin) {
      setFrame(null);
      return;
    }
    const map = mapRef.current;
    if (!map) return;
    let raf = 0;
    const update = () => {
      const shell = map.getContainer().parentElement;
      if (!shell) return;
      const shellBox = shell.getBoundingClientRect();
      const root = rootRef.current;
      const width = root?.offsetWidth ?? 320;
      const height = root?.offsetHeight ?? 360;
      const projected = map.project(pin);
      // Right of the pin, flipping left near the edge; vertically centred.
      let left = projected.x + 16;
      if (left + width > shellBox.width - 8) left = projected.x - 16 - width;
      left = Math.max(8, Math.min(left, Math.max(8, shellBox.width - width - 8)));
      let top = projected.y - height / 2;
      top = Math.max(8, Math.min(top, Math.max(8, shellBox.height - height - 8)));
      setFrame({ left, top, x: projected.x, y: projected.y });
    };
    update();
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(update);
    };
    map.on("move", schedule);
    map.on("resize", schedule);
    return () => {
      cancelAnimationFrame(raf);
      map.off("move", schedule);
      map.off("resize", schedule);
    };
    // Content changes (sections loading) change the card height → re-clamp.
  }, [
    open,
    pin,
    mapRef,
    changeStatus,
    sampleStatus,
    lookupStatus,
    hit,
  ]);

  if (!open || !frame) return null;

  return (
    <>
      {/* The inspected point itself, so the card visibly belongs to it. */}
      <div
        aria-hidden
        className="pointer-events-none absolute z-30 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-orange-600 shadow"
        style={{ left: frame.x, top: frame.y }}
      />
      <div
        ref={rootRef}
        role="dialog"
        aria-label="Map inspector"
        data-testid="map-inspector"
        className="absolute z-30 w-[19rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded border border-border bg-surface shadow-float"
        style={{ left: frame.left, top: frame.top }}
      >
        <InspectorBody onClose={close} header />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ body */

function InspectorBody({ onClose, header }: { onClose: () => void; header: boolean }) {
  const pin = useInspectorStore((s) => s.pin);
  const hit = useInspectorStore((s) => s.hit);
  const location = useInspectorStore((s) => s.location);
  const lookup = useInspectorStore((s) => s.lookup);
  const change = useInspectorStore((s) => s.change);
  const probe = useInspectorStore((s) => s.probe);
  const sample = useInspectorStore((s) => s.sample);
  const basemapWords = useInspectorStore((s) => s.basemapWords);
  const lookupPlace = useInspectorStore((s) => s.lookupPlace);
  const probeChange = useInspectorStore((s) => s.probeChange);
  const sampleNdvi = useInspectorStore((s) => s.sampleNdvi);
  const selectAdminArea = useInspectorStore((s) => s.selectAdminArea);
  const hasResult = useCompareStore((s) => Boolean(s.result));

  const basemap = useAppStore((s) => s.basemap);
  const pushToast = useAppStore((s) => s.pushToast);
  const scene = useActiveScene();
  const coordFormat = usePreferencesStore((s) => s.values.units.coordinates);
  const areaUnit = usePreferencesStore((s) => s.values.units.areaUnit);
  const sampleLocked = useLocked("inspect.sample");
  const quota = useQuotaToday("inspectSample");

  const fieldsResponse = useFieldsStore((s) => s.fields);
  const pattern = useFieldsStore((s) => s.pattern);
  const fieldId = hit?.kind === "field" ? hit.fieldId : null;
  const fieldFeature = useMemo(
    () => fieldsResponse?.features.find((f) => String(f.id) === fieldId) ?? null,
    [fieldsResponse, fieldId],
  );
  const patternRow = useMemo(
    () => (fieldId ? patternById(pattern).get(fieldId) ?? null : null),
    [pattern, fieldId],
  );

  const [copied, setCopied] = useState(false);
  if (!pin) return null;
  const [lng, lat] = pin;

  const copyCoords = () => {
    void navigator.clipboard?.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  const setArea = (level: "tehsil" | "district") => {
    const ok = selectAdminArea(level);
    if (ok && location) {
      const name = level === "tehsil" ? location.tehsil : location.district;
      pushToast({ tone: "success", message: `Area set to ${name ?? level}.` });
    }
  };

  const copernicusUrl = scene
    ? buildCopernicusBrowserUrl({
        bbox: [lng - 0.01, lat - 0.01, lng + 0.01, lat + 0.01],
        date: scene.date,
        lat,
        lng,
        composite: scene.composite,
      })
    : null;
  const googleUrl = `https://www.google.com/maps?q=${lat},${lng}`;

  return (
    <>
      {header && (
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h2 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-text">
            <MapPin size={14} className="shrink-0 text-muted" aria-hidden />
            Map inspector
          </h2>
          <Button variant="ghost" size="icon" aria-label="Close map inspector" onClick={onClose}>
            <X size={16} />
          </Button>
        </header>
      )}

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-2.5">
        {/* ---------------------------------------------------- Location */}
        <section aria-label="Location">
          <SectionTitle>Location</SectionTitle>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-text">{formatCoords(lng, lat, coordFormat)}</span>
              <Button variant="ghost" size="icon" aria-label="Copy coordinates" onClick={copyCoords}>
                {copied ? <Check size={14} className="text-emerald-600" /> : <Clipboard size={14} />}
              </Button>
            </div>
            {location?.district && <Row label="District" value={location.district} />}
            {location?.tehsil && <Row label="Tehsil" value={location.tehsil} />}
            {location?.ilr && <Row label="Irrigation block" value={location.ilr} />}
            {basemapWords.length > 0 && (
              <Row label="On the map" value={basemapWords.join(", ")} />
            )}
            {basemap === "satellite" && (
              <div className="pt-0.5">
                {lookup.status === "done" && lookup.name ? (
                  <div className="space-y-0.5">
                    <Row label="Place" value={lookup.name} />
                    <p className="text-[10px] text-muted">{OSM_ATTRIBUTION}</p>
                  </div>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={lookup.status === "loading"}
                    onClick={lookupPlace}
                  >
                    {lookup.status === "loading" ? (
                      "Looking up…"
                    ) : (
                      <>
                        <Search size={13} aria-hidden /> Look up place name
                      </>
                    )}
                  </Button>
                )}
                {lookup.status === "error" && (
                  <div className="space-y-1">
                    <p className="text-xs text-danger">{lookup.error}</p>
                    <Button variant="secondary" size="sm" onClick={lookupPlace}>
                      Retry
                    </Button>
                  </div>
                )}
              </div>
            )}
            {(location?.tehsil || location?.district) && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {location.tehsil && (
                  <Button variant="secondary" size="sm" onClick={() => setArea("tehsil")}>
                    Select this tehsil
                  </Button>
                )}
                {location.district && (
                  <Button variant="secondary" size="sm" onClick={() => setArea("district")}>
                    Select this district
                  </Button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------------- Field */}
        {hit?.kind === "field" && (
          <section aria-label="Field" className="border-t border-border pt-2.5">
            <SectionTitle>Field</SectionTitle>
            {!fieldFeature ? (
              <p className="text-xs text-muted">
                Field details are no longer loaded for this spot.
              </p>
            ) : (
              <div className="space-y-1.5">
                <Row
                  label="Area"
                  value={formatArea(fieldFeature.properties.areaM2 / 10_000, areaUnit)}
                />
                <Row
                  label="Confidence"
                  value={
                    fieldFeature.properties.confidence !== null
                      ? `${Math.round(fieldFeature.properties.confidence)}%`
                      : "—"
                  }
                />
                {pattern && (
                  <Row label="Pattern" value={patternRow ? patternClassLabel(patternRow.cls) : "Unclassified"} />
                )}
                {patternRow?.group !== null && patternRow?.group !== undefined && (
                  <Row label="Group" value={`#${patternRow.group}`} />
                )}
                {patternRow?.series && (
                  <div className="pt-1">
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">
                      NDVI by month
                    </p>
                    <NdviSparkline series={patternRow.series} />
                  </div>
                )}
                <div className="pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => useFieldsStore.getState().selectField(fieldId)}
                  >
                    Select this field
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        {/* ----------------------------------------------------- Change */}
        {(change.status !== "idle" || hit?.kind === "event") && (
          <section aria-label="Change" className="border-t border-border pt-2.5">
            <SectionTitle>
              Change
              {hit?.kind === "event" && (
                <span className="ml-1.5 font-normal normal-case text-muted">
                  event #{hit.rank}
                </span>
              )}
            </SectionTitle>
            {change.status === "loading" && (
              <p className="text-xs text-muted">Checking the analysis at this point…</p>
            )}
            {change.status === "error" && (
              <div className="space-y-1">
                <p className="text-xs text-danger">{change.error}</p>
              </div>
            )}
            {change.status === "done" && change.info && (
              <ChangeView info={change.info} areaUnit={areaUnit} />
            )}
            {hasResult && (change.status === "done" || change.status === "error") && (
              <div className="space-y-1.5 pt-1.5">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={probe.status === "loading"}
                  onClick={probeChange}
                >
                  {probe.status === "loading" ? "Probing…" : "Probe at native 10 m"}
                </Button>
                {probe.status === "loading" && (
                  <p className="text-xs text-muted">
                    Classifying a ~480 m window around this point…
                  </p>
                )}
                {probe.status === "done" && probe.info && <ProbeView info={probe.info} />}
                {probe.status === "error" && <p className="text-xs text-danger">{probe.error}</p>}
              </div>
            )}
          </section>
        )}

        {/* ---------------------------------------------------- Imagery */}
        {scene && (
          <section aria-label="Imagery" className="border-t border-border pt-2.5">
            <SectionTitle>Imagery</SectionTitle>
            <div className="space-y-1.5">
              <Button
                variant="secondary"
                size="sm"
                disabled={sampleLocked || sample.status === "loading"}
                onClick={() => sampleNdvi(scene)}
              >
                {sample.status === "loading" ? "Sampling…" : "Sample NDVI here"}
              </Button>
              {sample.status === "done" && sample.info && (
                <>
                  <Row
                    label="NDVI"
                    value={sample.info.ndvi !== null ? sample.info.ndvi.toFixed(2) : "No data"}
                  />
                  <Row
                    label="Conditions"
                    value={
                      sample.info.clear === null
                        ? "—"
                        : sample.info.clear
                          ? "Clear"
                          : "Cloudy"
                    }
                  />
                </>
              )}
              {sample.status === "error" && (
                <p className="text-xs text-danger">{sample.error}</p>
              )}
              {sampleLocked && (
                <p className="text-xs text-muted">NDVI sample quota reached for today.</p>
              )}
              {!sampleLocked && quota && (
                <p className="text-[10px] text-muted">
                  {quota.remaining} of {quota.limit} samples left today
                </p>
              )}
            </div>
          </section>
        )}

        {/* ----------------------------------------------------- Actions */}
        <section aria-label="Actions" className="border-t border-border pt-2.5">
          <SectionTitle>Open elsewhere</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {copernicusUrl && (
              <a
                className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-text transition-colors duration-150 hover:bg-surface-2"
                href={copernicusUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink size={12} aria-hidden /> Copernicus Browser
              </a>
            )}
            <a
              className="inline-flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-text transition-colors duration-150 hover:bg-surface-2"
              href={googleUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={12} aria-hidden /> Google Maps
            </a>
          </div>
        </section>
      </div>
    </>
  );
}

/* --------------------------------------------------------------- pieces */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
      {children}
    </h3>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-text" title={value}>
        {value}
      </span>
    </div>
  );
}

function ChangeView({
  info,
  areaUnit,
}: {
  info: NonNullable<ReturnType<typeof useInspectorStore.getState>["change"]["info"]>;
  areaUnit: "ha" | "km2" | "acre";
}) {
  if (info.kind === "none") {
    return <p className="text-xs text-text">No significant change at this point.</p>;
  }
  if (info.kind === "outside") {
    return <p className="text-xs text-muted">Outside the analysed area.</p>;
  }
  if (info.kind === "masked") {
    return <p className="text-xs text-muted">Cloud or shadow covers this point in the analysis.</p>;
  }
  const [r, g, b] = classColor(info.classCode);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="h-3 w-3 shrink-0 rounded-sm border border-border"
          style={{ background: `rgb(${r}, ${g}, ${b})` }}
        />
        <span className="text-xs font-medium text-text">{info.classLabel}</span>
      </div>
      {info.patch ? (
        <div className="space-y-1.5">
          <Row label="Patch" value={info.patch.id} />
          <Row label="Patch area" value={formatArea(info.patch.areaHa, areaUnit)} />
          <Row
            label="Confidence"
            value={
              info.patch.confidence
                ? `${info.patch.confidence}${info.patch.confidencePct !== null ? ` · ${info.patch.confidencePct}%` : ""}`
                : "—"
            }
          />
          {info.patch.evidence && <Row label="Evidence" value={info.patch.evidence} />}
        </div>
      ) : (
        <p className="text-xs text-muted">Change pixel outside any mapped patch.</p>
      )}
    </div>
  );
}

/** Sensitivity ladder for the probe's "re-run higher" suggestion. */
const SENSITIVITY_NEXT: Record<Sensitivity, Sensitivity | null> = {
  low: "medium",
  medium: "high",
  high: "veryhigh",
  veryhigh: null,
  auto: "veryhigh",
};

/**
 * Phase 4 probe verdict: explains the point at native 10 m and offers the
 * matching re-run action (higher sensitivity for near-misses, a smaller
 * minimum patch when the MMU cut a real change).
 */
function ProbeView({ info }: { info: ProbeResult }) {
  const result = useCompareStore((s) => s.result);
  const setSensitivity = useCompareStore((s) => s.setSensitivity);
  const setMinPatchHa = useCompareStore((s) => s.setMinPatchHa);
  const run = useCompareStore((s) => s.run);

  const probedSensitivity = result?.stats.metadata.sensitivity ?? "medium";
  const higher = SENSITIVITY_NEXT[probedSensitivity] ?? null;

  const thresholds = info.thresholds;
  const ndviT = Math.max(Math.abs(thresholds.vegLossDNdvi ?? 0), Math.abs(thresholds.vegGainDNdvi ?? 0));
  const mndwiT = Math.max(
    Math.abs(thresholds.waterLossDMndwi ?? 0),
    Math.abs(thresholds.waterGainDMndwi ?? 0),
  );
  const ndbiT = Math.abs(thresholds.bareBuiltDNdbi ?? 0);

  const rerunHigher = () => {
    if (!higher) return;
    setSensitivity(higher);
    void run();
  };
  const rerunSmaller = () => {
    setMinPatchHa(0.01);
    void run();
  };

  if (info.verdict === "kept") {
    return (
      <p className="text-xs text-text">
        Confirmed at native 10 m: {info.classLabel} patch ≈ {info.patchHa?.toFixed(2)} ha
        {info.clipped ? " (extends past the 480 m window)" : ""}
        {info.confidence ? ` · ${info.confidence} confidence` : ""}.
      </p>
    );
  }
  if (info.verdict === "masked") {
    const dateWord =
      info.coverage === "a-missing"
        ? " on date A"
        : info.coverage === "b-missing"
          ? " on date B"
          : "";
    return (
      <p className="text-xs text-muted">
        Cloud or missing data covers this spot{dateWord} — the probe cannot classify it.
      </p>
    );
  }
  if (info.verdict === "no-change") {
    return (
      <p className="text-xs text-muted">
        No change signal here at native 10 m (ΔNDVI {info.deltas.ndvi.toFixed(2)} · ΔMNDWI{" "}
        {info.deltas.mndwi.toFixed(2)} · ΔNDBI {info.deltas.ndbi.toFixed(2)}).
      </p>
    );
  }
  if (info.verdict === "sub-threshold") {
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted">
          Deltas stay below the thresholds — ΔNDVI {info.deltas.ndvi.toFixed(2)} (±
          {ndviT.toFixed(2)}) · ΔMNDWI {info.deltas.mndwi.toFixed(2)} (±{mndwiT.toFixed(2)}) ·
          ΔNDBI {info.deltas.ndbi.toFixed(2)} (±{ndbiT.toFixed(2)}).
        </p>
        {higher ? (
          <Button variant="secondary" size="sm" onClick={rerunHigher}>
            Re-run with {higher === "veryhigh" ? "very high" : higher} sensitivity
          </Button>
        ) : (
          <p className="text-[10px] text-muted">Already at the highest sensitivity.</p>
        )}
      </div>
    );
  }
  // below-mmu
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-text">
        {info.classLabel} detected — the patch (≈ {info.patchHa?.toFixed(2)} ha
        {info.clipped ? ", extends past the window" : ""}) is below the{" "}
        {info.minPatchHa.toFixed(2)} ha minimum patch size, so it was cut.
      </p>
      {info.minPatchHa > 0.01 && (
        <Button variant="secondary" size="sm" onClick={rerunSmaller}>
          Re-run with 0.01 ha patches
        </Button>
      )}
    </div>
  );
}

/** 12-month NDVI line — gaps (nulls) break the polyline into segments. */
function NdviSparkline({ series }: { series: number[] }) {
  const width = 240;
  const height = 44;
  const pad = 3;
  const finite = series.map((value) => (Number.isFinite(value) ? value : null));
  const values = finite.filter((value): value is number => value !== null);
  if (values.length < 2) {
    return <p className="text-xs text-muted">Not enough monthly NDVI for a sparkline.</p>;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xAt = (index: number): number =>
    pad + (index / Math.max(series.length - 1, 1)) * (width - pad * 2);
  const yAt = (value: number): number =>
    height - pad - ((value - min) / span) * (height - pad * 2);
  const segments: string[] = [];
  let current: string[] = [];
  finite.forEach((value, index) => {
    if (value === null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(`${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      className="text-emerald-600 dark:text-emerald-400"
      role="img"
      aria-label="Monthly NDVI sparkline"
    >
      {segments.map((points, index) => (
        <polyline
          key={index}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
