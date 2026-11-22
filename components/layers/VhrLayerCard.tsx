"use client";

import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Send } from "lucide-react";
import { RAJASTHAN_BBOX, bboxToPolygon } from "@/lib/map/constants";
import type { VhrScene } from "@/lib/vhr/types";
import { selectActiveSelection, useAppStore } from "@/store/useAppStore";
import { useSession, useLocked } from "@/store/useSession";
import Button from "@/components/ui/Button";
import FeatureLock from "@/components/ui/FeatureLock";
import Select from "@/components/ui/Select";
import Slider from "@/components/ui/Slider";
import { cn } from "@/components/ui/cn";
import { formatShortDate } from "@/components/compare/CompareBar";

/**
 * Layers card for the high-resolution (NRSC Bhoonidhi) imagery: scene list,
 * show/hide, opacity, the Sentinel-2 swipe controls and the admin request
 * button. Guests get the locked state (padlock popover + request button);
 * the API enforces the same vhr.view capability server-side.
 */

/** Cheap bbox area (km²) — good enough for the "covered area" readout. */
function approxAreaKm2(bbox: [number, number, number, number]): number {
  const [west, south, east, north] = bbox;
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const widthKm = (east - west) * 111.32 * Math.cos(midLat);
  const heightKm = (north - south) * 110.57;
  return Math.max(0, widthKm * heightKm);
}

function shiftIsoDay(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nearestDate(dates: string[], target: string): string | null {
  let best: string | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const date of dates) {
    const delta = Math.abs(Date.parse(`${date}T00:00:00Z`) - Date.parse(`${target}T00:00:00Z`));
    if (delta < bestDelta) {
      bestDelta = delta;
      best = date;
    }
  }
  return best;
}

type RequestStatus = { phase: "idle" | "sending" | "sent" | "error"; message?: string };

export default function VhrLayerCard() {
  const locked = useLocked("vhr.view");
  const sessionStatus = useSession((s) => s.status);

  const vhrScenes = useAppStore((s) => s.vhrScenes);
  const vhrSceneId = useAppStore((s) => s.vhrSceneId);
  const setVhrScene = useAppStore((s) => s.setVhrScene);
  const setVhrScenes = useAppStore((s) => s.setVhrScenes);
  const vhrVisible = useAppStore((s) => s.vhrVisible);
  const toggleVhr = useAppStore((s) => s.toggleVhr);
  const vhrOpacity = useAppStore((s) => s.vhrOpacity);
  const setVhrOpacity = useAppStore((s) => s.setVhrOpacity);
  const vhrSwipe = useAppStore((s) => s.vhrSwipe);
  const setVhrSwipe = useAppStore((s) => s.setVhrSwipe);
  const vhrSwipeDate = useAppStore((s) => s.vhrSwipeDate);
  const setVhrSwipeDate = useAppStore((s) => s.setVhrSwipeDate);
  const vhrDivider = useAppStore((s) => s.vhrDivider);
  const setVhrDivider = useAppStore((s) => s.setVhrDivider);
  const selection = useAppStore(selectActiveSelection);
  const fromDate = useAppStore((s) => s.fromDate);
  const toDate = useAppStore((s) => s.toDate);

  const [fetchState, setFetchState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [request, setRequest] = useState<RequestStatus>({ phase: "idle" });
  const [dateOptions, setDateOptions] = useState<string[]>([]);
  const [datesLoading, setDatesLoading] = useState(false);
  const [datesError, setDatesError] = useState<string | null>(null);
  const datesKeyRef = useRef<string | null>(null);

  const bbox = selection?.bbox ?? RAJASTHAN_BBOX;
  const bboxKey = bbox.join(",");

  // ------------------------------------------------ scenes for this bbox
  useEffect(() => {
    if (locked || sessionStatus === "unknown") return;
    let cancelled = false;
    setFetchState("loading");
    setFetchError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/vhr/scenes?bbox=${encodeURIComponent(bboxKey)}`, {
          credentials: "same-origin",
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { message?: string }
            | null;
          throw new Error(body?.message ?? "High-resolution imagery is unavailable right now.");
        }
        const data = (await response.json()) as { scenes?: VhrScene[] };
        if (cancelled) return;
        setVhrScenes(Array.isArray(data.scenes) ? data.scenes : []);
        setFetchState("ready");
      } catch (error) {
        if (cancelled) return;
        setFetchState("error");
        setFetchError(error instanceof Error && error.message ? error.message : "Could not load scenes.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bboxKey, locked, sessionStatus, setVhrScenes]);

  const scene = vhrScenes.find((candidate) => candidate.id === vhrSceneId) ?? null;

  // Drop a swipe date that no longer exists after a bbox change.
  useEffect(() => {
    if (vhrSwipeDate && dateOptions.length > 0 && !dateOptions.includes(vhrSwipeDate)) {
      setVhrSwipeDate(nearestDate(dateOptions, scene?.acquiredAt.slice(0, 10) ?? dateOptions[0]!));
    }
  }, [dateOptions, vhrSwipeDate, scene, setVhrSwipeDate]);

  // ------------------------------------------------ Sentinel-2 date options
  const selectionKey = selection ? `${selection.level}:${selection.id}` : "";
  const swipeSceneKey = scene?.id ?? "";
  useEffect(() => {
    if (!vhrSwipe || !scene || !selection) return;
    const key = `${selectionKey}|${swipeSceneKey}`;
    if (datesKeyRef.current === key && dateOptions.length > 0) return;
    let cancelled = false;
    setDatesLoading(true);
    setDatesError(null);
    const acquiredDay = scene.acquiredAt.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const body = {
      districtId: selection.level === "district" ? selection.id : null,
      tehsilId: selection.level === "tehsil" ? selection.id : null,
      ilrId: selection.level === "ilr" ? selection.id : null,
      fromDate: shiftIsoDay(acquiredDay, -60),
      toDate: shiftIsoDay(acquiredDay, 60) > today ? today : shiftIsoDay(acquiredDay, 60),
      maxCloudCover: 50,
      composite: "false-color",
    };
    void (async () => {
      try {
        const response = await fetch("/api/scenes", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error();
        const data = (await response.json()) as { scenes?: Array<{ date: string }> };
        if (cancelled) return;
        const dates = Array.from(new Set((data.scenes ?? []).map((entry) => entry.date))).sort();
        datesKeyRef.current = key;
        setDateOptions(dates);
        const nearest = nearestDate(dates, acquiredDay);
        if (nearest) setVhrSwipeDate(nearest);
        else setDatesError("No Sentinel-2 scenes near this acquisition date.");
      } catch {
        if (!cancelled) setDatesError("Could not load Sentinel-2 dates. Try again shortly.");
      } finally {
        if (!cancelled) setDatesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vhrSwipe, selectionKey, swipeSceneKey, scene, selection]);

  // ------------------------------------------------ admin request email
  const sendRequest = async (): Promise<void> => {
    if (request.phase === "sending") return;
    setRequest({ phase: "sending" });
    try {
      const aoi = selection ? selection.geometry : bboxToPolygon(RAJASTHAN_BBOX);
      const response = await fetch("/api/vhr/request", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          aoi,
          areaName: selection ? selection.name : "Rajasthan",
          startDate: fromDate,
          endDate: toDate,
        }),
      });
      if (response.ok) {
        setRequest({ phase: "sent" });
        return;
      }
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      setRequest({
        phase: "error",
        message: body?.message ?? "Your request could not be sent. Try again shortly.",
      });
    } catch {
      setRequest({ phase: "error", message: "Your request could not be sent. Try again shortly." });
    }
  };

  const requestButton = (
    <div className="mt-2 pl-[2.75rem]">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => void sendRequest()}
        disabled={request.phase === "sending"}
        className="gap-1.5"
      >
        <Send size={13} aria-hidden />
        {request.phase === "sending"
          ? "Sending…"
          : request.phase === "sent"
            ? "Request sent"
            : "Request high-resolution imagery for this area"}
      </Button>
      {request.phase === "error" && request.message && (
        <p className="mt-1 text-[11px] text-warning">{request.message}</p>
      )}
      {request.phase === "sent" && (
        <p className="mt-1 text-[11px] text-muted">
          Sent to the administrators with this area&apos;s GeoJSON attached.
        </p>
      )}
    </div>
  );

  // ------------------------------------------------ locked (guest) state
  if (locked) {
    return (
      <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="block h-3 w-8 rounded-sm border border-border"
            style={{ background: "linear-gradient(135deg, #8b2e2e, #3e6b2f)" }}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-text">High-resolution imagery</p>
            <p className="truncate text-xs text-muted">NRSC Bhoonidhi · SSO only</p>
          </div>
          <FeatureLock capability="vhr.view" label="High-resolution imagery" />
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted">
          5.8 m LISS-IV scenes ingested from Bhoonidhi are available with an SSO ID. You can still
          ask the administrators to ingest an area for you.
        </p>
        {requestButton}
      </div>
    );
  }

  // ------------------------------------------------ SSO state
  const checked = vhrVisible && scene !== null;
  const sceneDescription = scene
    ? `${formatShortDate(scene.acquiredAt)} · ${scene.sensor} · ${scene.resolutionM} m · ~${Math.round(
        approxAreaKm2(scene.bbox),
      ).toLocaleString()} km²`
    : fetchState === "loading"
      ? "Loading high-resolution scenes…"
      : fetchState === "error"
        ? (fetchError ?? "High-resolution imagery is unavailable right now.")
        : "No high-resolution scenes for this area yet";

  return (
    <div
      className={cn(
        "rounded border px-2.5 py-2 transition-colors duration-150",
        checked ? "border-border bg-surface" : "border-border bg-surface-2",
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="block h-3 w-8 rounded-sm border border-border"
          style={{ background: "linear-gradient(135deg, #8b2e2e, #3e6b2f)" }}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text">High-resolution imagery</p>
          <p className="truncate text-xs text-muted">{sceneDescription}</p>
        </div>
        <button
          type="button"
          onClick={toggleVhr}
          aria-pressed={checked}
          aria-label={`${checked ? "Hide" : "Show"} high-resolution imagery`}
          disabled={!scene}
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded transition-colors duration-150",
            checked ? "text-accent hover:bg-accent-soft" : "text-muted hover:bg-surface hover:text-text",
            !scene && "cursor-not-allowed opacity-50",
          )}
        >
          {checked ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
      </div>

      {checked && (
        <>
          <div className="mt-2 space-y-2 pl-[2.75rem]">
            <Select
              aria-label="High-resolution scene"
              value={vhrSceneId ?? ""}
              onChange={(event) => setVhrScene(event.target.value || null)}
            >
              {vhrScenes.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {`${formatShortDate(candidate.acquiredAt)} · ${candidate.sensor}`}
                </option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <Slider
                min={0}
                max={100}
                step={5}
                value={Math.round(vhrOpacity * 100)}
                aria-label="High-resolution imagery opacity"
                onChange={(event) => setVhrOpacity(Number(event.target.value) / 100)}
              />
              <span className="mono-nums w-9 shrink-0 text-right text-xs text-muted">
                {Math.round(vhrOpacity * 100)}%
              </span>
            </div>
          </div>

          <div className="mt-2 pl-[2.75rem]">
            <Button
              type="button"
              variant={vhrSwipe ? "primary" : "secondary"}
              size="sm"
              disabled={!selection}
              onClick={() => setVhrSwipe(!vhrSwipe)}
            >
              {vhrSwipe ? "End swipe" : "Swipe vs Sentinel-2"}
            </Button>
            {!selection && (
              <p className="mt-1 text-[11px] text-muted">Select an area to compare.</p>
            )}
            {vhrSwipe && selection && (
              <div className="mt-2 space-y-2">
                {datesLoading ? (
                  <p className="text-[11px] text-muted">Loading Sentinel-2 dates…</p>
                ) : datesError ? (
                  <p className="text-[11px] text-warning">{datesError}</p>
                ) : dateOptions.length > 0 ? (
                  <Select
                    aria-label="Sentinel-2 date"
                    value={vhrSwipeDate ?? ""}
                    onChange={(event) => setVhrSwipeDate(event.target.value || null)}
                  >
                    {dateOptions.map((date) => (
                      <option key={date} value={date}>
                        {formatShortDate(date)}
                      </option>
                    ))}
                  </Select>
                ) : null}
                <div className="flex items-center gap-2">
                  <Slider
                    min={0}
                    max={100}
                    step={1}
                    value={Math.round(vhrDivider)}
                    aria-label="Swipe divider position"
                    onChange={(event) => setVhrDivider(Number(event.target.value))}
                  />
                  <span className="mono-nums w-9 shrink-0 text-right text-xs text-muted">
                    {Math.round(vhrDivider)}%
                  </span>
                </div>
                <p className="text-[11px] leading-snug text-muted">
                  Sentinel-2 (left) vs high-resolution (right), both in false colour.
                </p>
              </div>
            )}
          </div>

          <p className="mt-2 pl-[2.75rem] text-[10px] leading-snug text-muted">
            {scene?.licenseNote ? `${scene.licenseNote} · ` : ""}
            Source: NRSC / ISRO, via Bhoonidhi
          </p>
        </>
      )}

      {requestButton}
    </div>
  );
}
