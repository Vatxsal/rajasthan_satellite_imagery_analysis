"use client";

import { useState } from "react";
import type { CompositeId } from "@/lib/data";
import type { ThresholdOverrides } from "@/lib/analysis/config";
import {
  STATE_AREA_ID,
  isQueryRepoError,
  type QueryAreaLevel,
  type SavedQuery,
  type SavedQueryInput,
} from "@/lib/queries/repository";
import { suggestionOf } from "@/lib/queries/client";
import { useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";
import { useQueriesStore } from "@/store/useQueriesStore";
import { useLocked } from "@/store/useSession";
import Button from "@/components/ui/Button";
import FeatureLock from "@/components/ui/FeatureLock";
import Segmented from "@/components/ui/Segmented";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";

interface QueryAreaDraft {
  level: QueryAreaLevel;
  areaId: string;
  name: string;
}

type DateMode = "relative" | "absolute";

interface DateDraft {
  mode: DateMode;
  days: number;
  from: string;
  to: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/** Current filters → area (ILR > tehsil > district > whole state). */
function currentArea(): QueryAreaDraft {
  const state = useAppStore.getState();
  if (state.ilrSel) return { level: "ilr", areaId: state.ilrSel.id, name: state.ilrSel.name };
  if (state.tehsilSel) return { level: "tehsil", areaId: state.tehsilSel.id, name: state.tehsilSel.name };
  if (state.districtSel) {
    return { level: "district", areaId: state.districtSel.id, name: state.districtSel.name };
  }
  return { level: "state", areaId: STATE_AREA_ID, name: "Rajasthan" };
}

/**
 * Store range → saveable range: a range ending today with 1–1096 days of
 * history is captured as a rolling window (re-read from today on every run);
 * anything else is pinned to its exact dates.
 */
function currentRange(): DateDraft {
  const { fromDate, toDate } = useAppStore.getState();
  const today = todayIso();
  if (toDate === today) {
    const days = daysBetween(fromDate, toDate);
    if (days >= 1 && days <= 1096) {
      return { mode: "relative", days, from: fromDate, to: toDate };
    }
  }
  return { mode: "absolute", days: 90, from: fromDate, to: toDate };
}

/** "Jaipur · 120 days · ≤25% cloud" — falls back to fixed dates off-today. */
function suggestName(area: QueryAreaDraft, range: DateDraft, maxCloud: number): string {
  const window =
    range.mode === "relative"
      ? `${range.days} days`
      : `${range.from} to ${range.to}`;
  return `${area.name} · ${window} · ≤${maxCloud}% cloud`.slice(0, 80);
}

function initialDraft(editing: SavedQuery | null): {
  area: QueryAreaDraft;
  range: DateDraft;
  name: string;
  description: string;
  maxCloud: number;
  composite: CompositeId;
} {
  if (editing) {
    const range =
      editing.dateRange.mode === "relative"
        ? { mode: "relative" as const, days: editing.dateRange.days ?? 90, from: "", to: "" }
        : {
            mode: "absolute" as const,
            days: 90,
            from: editing.dateRange.from,
            to: editing.dateRange.to,
          };
    return {
      area: editing.area,
      range,
      name: editing.name,
      description: editing.description,
      maxCloud: editing.maxCloud,
      composite: editing.composite,
    };
  }
  const area = currentArea();
  const range = currentRange();
  const { maxCloudCover, composite } = useAppStore.getState();
  return {
    area,
    range,
    name: suggestName(area, range, maxCloudCover),
    description: "",
    maxCloud: maxCloudCover,
    composite,
  };
}

const COMPOSITE_LABELS: Record<CompositeId, string> = {
  "true-color": "True colour",
  "false-color": "False colour",
  ndvi: "NDVI",
};

function SaveDialogInner({
  editing,
  onClose,
}: {
  editing: SavedQuery | null;
  onClose: () => void;
}) {
  const create = useQueriesStore((s) => s.create);
  const update = useQueriesStore((s) => s.update);
  const lockedCompare = useLocked("compare.adjust-sensitivity");

  const initial = initialDraft(editing);

  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [mode, setMode] = useState<DateMode>(initial.range.mode);
  const [days, setDays] = useState(initial.range.days);
  const [from, setFrom] = useState(initial.range.from);
  const [to, setTo] = useState(initial.range.to);
  const [maxCloud, setMaxCloud] = useState(initial.maxCloud);
  const [composite, setComposite] = useState<CompositeId>(initial.composite);
  const [sensitivity, setSensitivity] = useState(
    () => editing?.compare?.sensitivity ?? useCompareStore.getState().sensitivity,
  );
  const [minPatchHa, setMinPatchHa] = useState(
    () => editing?.compare?.minPatchHa ?? useCompareStore.getState().minPatchHa,
  );
  // Phase-thresholds: the current overrides ride the saved query (null =
  // preset thresholds). Guests save presets only, like the other tuning.
  const [thresholds, setThresholds] = useState(() =>
    editing?.compare?.thresholds
      ? (editing.compare.thresholds as ThresholdOverrides)
      : useCompareStore.getState().thresholds,
  );

  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSuggestion, setNameSuggestion] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const applySuggestion = () => {
    if (!nameSuggestion) return;
    setName(nameSuggestion);
    setNameError(null);
    setNameSuggestion(null);
  };

  const submit = async () => {
    if (busy) return;
    const cleanName = name.trim();
    if (!cleanName) {
      setNameError("Give this query a name.");
      return;
    }
    if (mode === "absolute" && Date.parse(from) > Date.parse(to)) {
      setFormError("The from date must be on or before the to date.");
      return;
    }
    const dateRange =
      mode === "relative"
        ? ({ mode: "relative", days: Math.min(1096, Math.max(1, Math.round(days))) } as const)
        : ({ mode: "absolute", from, to } as const);

    const input: SavedQueryInput = {
      name: cleanName,
      description,
      area: initial.area,
      dateRange,
      maxCloud: Math.min(100, Math.max(0, Math.round(maxCloud))),
      composite,
      // Guests keep the server defaults — the API would refuse tuning anyway.
      ...(lockedCompare
        ? {}
        : {
            compare: {
              sensitivity,
              minPatchHa,
              ...(thresholds ? { thresholds } : {}),
            },
          }),
    };

    setBusy(true);
    setNameError(null);
    setNameSuggestion(null);
    setFormError(null);
    try {
      if (editing) {
        await update(editing.id, input);
        useAppStore.getState().pushToast({
          tone: "success",
          message: `Updated “${cleanName}”`,
        });
      } else {
        await create(input);
        useAppStore.getState().pushToast({
          tone: "success",
          message: `Saved “${cleanName}”`,
        });
      }
      onClose();
    } catch (error) {
      if (isQueryRepoError(error) && error.code === "NAME_TAKEN") {
        setNameError(error.message);
        const suggestion = suggestionOf(error);
        if (suggestion) setNameSuggestion(suggestion);
      } else {
        setFormError(error instanceof Error ? error.message : "Could not save this query.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent>
      <DialogTitle>{editing ? "Edit saved query" : "Save query"}</DialogTitle>
      <DialogDescription>
        {editing
          ? "Update what this saved query keeps."
          : "Captures the current filters. Rolling dates re-read from today each time you run it."}
      </DialogDescription>

      <form
        className="mt-4 space-y-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {/* ------------------------------------------------------- name */}
        <div>
          <label className="mb-1 block text-sm text-muted" htmlFor="save-query-name">
            Name
          </label>
          <input
            id="save-query-name"
            value={name}
            maxLength={80}
            autoComplete="off"
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
              setNameSuggestion(null);
            }}
            className="h-8 w-full rounded border border-border bg-surface px-2 text-sm text-text transition-colors duration-150 hover:border-muted focus:border-accent focus:outline-none"
          />
          {nameError && <p className="mt-1 text-[11px] text-danger">{nameError}</p>}
          {nameSuggestion && (
            <button
              type="button"
              className="mt-1 text-[11px] font-medium text-accent hover:underline"
              onClick={applySuggestion}
            >
              Use “{nameSuggestion}” instead
            </button>
          )}
        </div>

        {/* ------------------------------------------------- description */}
        <div>
          <label className="mb-1 block text-sm text-muted" htmlFor="save-query-description">
            Description <span className="text-[11px]">(optional)</span>
          </label>
          <textarea
            id="save-query-description"
            value={description}
            maxLength={200}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full rounded border border-border bg-surface px-2 py-1.5 text-sm text-text transition-colors duration-150 hover:border-muted focus:border-accent focus:outline-none"
          />
        </div>

        {/* ------------------------------------------------------- area */}
        <div>
          <h3 className="section-label">Area</h3>
          <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
            <p className="text-sm text-text">{initial.area.name}</p>
            <p className="text-[11px] capitalize text-muted">
              {initial.area.level}
              {!editing && " · from the current filters"}
            </p>
          </div>
        </div>

        {/* -------------------------------------------------- date range */}
        <div className="space-y-2">
          <h3 className="section-label">Date range</h3>
          <Segmented
            ariaLabel="Date range mode"
            value={mode}
            onChange={(value) => setMode(value as DateMode)}
            options={[
              { value: "relative", label: "Rolling window" },
              { value: "absolute", label: "Fixed dates" },
            ]}
          />
          {mode === "relative" ? (
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted" htmlFor="save-query-days">
                Last
              </label>
              <input
                id="save-query-days"
                type="number"
                min={1}
                max={1096}
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                className="mono-nums h-8 w-20 rounded border border-border bg-surface px-2 text-sm text-text transition-colors duration-150 hover:border-muted focus:border-accent focus:outline-none"
              />
              <span className="text-sm text-muted">days, ending today</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-sm text-muted" htmlFor="save-query-from">
                  From
                </label>
                <input
                  id="save-query-from"
                  type="date"
                  value={from}
                  max={to}
                  onChange={(event) => setFrom(event.target.value)}
                  className="mono-nums h-8 w-full rounded border border-border bg-surface px-2 text-sm text-text transition-colors duration-150 hover:border-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted" htmlFor="save-query-to">
                  To
                </label>
                <input
                  id="save-query-to"
                  type="date"
                  value={to}
                  min={from}
                  onChange={(event) => setTo(event.target.value)}
                  className="mono-nums h-8 w-full rounded border border-border bg-surface px-2 text-sm text-text transition-colors duration-150 hover:border-muted focus:border-accent focus:outline-none"
                />
              </div>
            </div>
          )}
        </div>

        {/* -------------------------------------------------- cloud cover */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="text-sm text-muted" htmlFor="save-query-cloud">
              Maximum cloud cover
            </label>
            <div className="flex items-center gap-1.5">
              <input
                id="save-query-cloud"
                type="number"
                min={0}
                max={100}
                step={5}
                value={maxCloud}
                onChange={(event) => setMaxCloud(Number(event.target.value))}
                className="mono-nums h-7 w-14 rounded border border-border bg-surface px-1.5 text-right text-sm text-text"
              />
              <span className="text-sm text-muted">%</span>
            </div>
          </div>
        </div>

        {/* ---------------------------------------------------- composite */}
        <div className="space-y-2">
          <h3 className="section-label">Composite</h3>
          <Segmented
            ariaLabel="Band composite"
            value={composite}
            onChange={(value) => setComposite(value as CompositeId)}
            options={[
              { value: "true-color", label: COMPOSITE_LABELS["true-color"] },
              { value: "false-color", label: COMPOSITE_LABELS["false-color"] },
              { value: "ndvi", label: COMPOSITE_LABELS.ndvi },
            ]}
          />
        </div>

        {/* ----------------------------------------------------- compare */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="section-label">Compare defaults</h3>
            <FeatureLock capability="compare.adjust-sensitivity" label="Adjust sensitivity" />
          </div>
          {lockedCompare ? (
            <p className="text-[11px] leading-snug text-muted">
              Guests run change detection at the default sensitivity. Sign in with an SSO ID to
              save your own compare settings.
            </p>
          ) : (
            <>
              <div>
                <label className="mb-1 block text-sm text-muted" htmlFor="save-query-sensitivity">
                  Sensitivity
                </label>
                <Segmented
                  id="save-query-sensitivity"
                  ariaLabel="Change detection sensitivity"
                  value={sensitivity}
                  onChange={(value) => setSensitivity(value as typeof sensitivity)}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                    { value: "veryhigh", label: "Very high" },
                    { value: "auto", label: "Auto" },
                  ]}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted" htmlFor="save-query-patch">
                  Minimum patch size (ha)
                </label>
                <input
                  id="save-query-patch"
                  type="number"
                  min={0.01}
                  max={100}
                  step={0.01}
                  value={minPatchHa}
                  onChange={(event) => setMinPatchHa(Number(event.target.value))}
                  className="mono-nums h-8 w-24 rounded border border-border bg-surface px-2 text-sm text-text transition-colors duration-150 hover:border-muted focus:border-accent focus:outline-none"
                />
              </div>
              <div className="md:col-span-2">
                <label className="flex items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={thresholds !== null && Object.keys(thresholds).length > 0}
                    disabled={useCompareStore.getState().thresholds === null}
                    onChange={(event) => {
                      // Include / exclude the current per-rule overrides.
                      // (Only possible when some are actually set.)
                      setThresholds(event.target.checked ? useCompareStore.getState().thresholds : null);
                    }}
                    aria-label="Include custom detection thresholds"
                    className="h-3.5 w-3.5 accent-[color:var(--accent)]"
                  />
                  Include the current custom thresholds
                  {useCompareStore.getState().thresholds === null ? (
                    <span className="text-xs text-muted">
                      — none set (tune them in Stats → Method &amp; settings after a run)
                    </span>
                  ) : null}
                </label>
              </div>
            </>
          )}
        </div>

        {formError && (
          <p className="rounded border border-danger/50 bg-danger/10 px-2.5 py-2 text-xs text-danger">
            {formError}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save changes" : "Save query"}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

/**
 * Save/Edit dialog, mounted once from app/page.tsx so the Save button in the
 * Filters panel works without the Saved tab being open. Fresh inner mount per
 * target (keyed) so every open starts from a clean prefill.
 */
export default function SaveQueryDialog() {
  const open = useQueriesStore((s) => s.saveDialog.open);
  const editing = useQueriesStore((s) => s.saveDialog.editing);
  const closeSave = useQueriesStore((s) => s.closeSave);

  if (!open) return null;
  return (
    <Dialog open onOpenChange={(next) => !next && closeSave()}>
      <SaveDialogInner key={editing?.id ?? "new"} editing={editing} onClose={closeSave} />
    </Dialog>
  );
}

/** Exported for the panel's "update with current filters" action. */
export function currentFiltersDraft(): {
  area: QueryAreaDraft;
  dateRange: SavedQueryInput["dateRange"];
  maxCloud: number;
  composite: CompositeId;
} {
  const range = currentRange();
  const { maxCloudCover, composite } = useAppStore.getState();
  return {
    area: currentArea(),
    dateRange:
      range.mode === "relative"
        ? { mode: "relative", days: range.days }
        : { mode: "absolute", from: range.from, to: range.to },
    maxCloud: maxCloudCover,
    composite,
  };
}
