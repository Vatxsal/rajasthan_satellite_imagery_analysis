"use client";

import { useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import Slider from "@/components/ui/Slider";
import Tooltip from "@/components/ui/Tooltip";
import FeatureLock, { useLocked } from "@/components/ui/FeatureLock";
import ThresholdHistogram, { type HistogramMarker } from "./ThresholdHistogram";
import { cn } from "@/components/ui/cn";
import {
  CLASS,
  presetThresholds,
  THRESHOLD_BOUNDS,
  type ScaledThresholds,
  type Sensitivity,
  type ThresholdField,
} from "@/lib/analysis/config";
import type { CompareMetadata } from "@/lib/analysis/types";
import type { DeltaHistogram } from "@/lib/analysis/diagnostics";
import { useCompareStore } from "@/store/useCompareStore";

/**
 * Phase-thresholds editor (Stats → Method & settings → "Thresholds used").
 * SSO-only: every rule gets a slider + numeric input bounded by the server's
 * zod clamps; presets fill the sliders; any edit marks the run "Custom".
 * The Δ histograms come from the analysis result, so the live share feedback
 * ("N px / X% beyond this threshold", ⚠ likely noise above ~5%) is pure
 * browser math — nothing is applied until the user presses Re-run.
 */

interface RuleDef {
  field: ThresholdField;
  label: string;
  tooltip: string;
}

const MAIN_RULES: RuleDef[] = [
  {
    field: "waterGainD",
    label: "Water gain — ΔMNDWI at least",
    tooltip:
      "MNDWI must rise at least this much for “new water”. Lower catches small ponds and canal fills, but also wet mud after rain.",
  },
  {
    field: "waterLossD",
    label: "Water loss — ΔMNDWI fall of",
    tooltip:
      "MNDWI must fall at least this much for “water disappeared”. Lower catches small dry-ups, but also seasonal drying noise.",
  },
  {
    field: "vegLossD",
    label: "Vegetation loss — ΔNDVI fall of",
    tooltip:
      "NDVI must drop at least this much for “vegetation loss”. Lower catches early stress and small clearings, but also crop-rotation noise.",
  },
  {
    field: "vegGainD",
    label: "Vegetation gain — ΔNDVI at least",
    tooltip:
      "NDVI must rise at least this much for “new vegetation”. Lower catches sparse greening, but also seasonal green-up noise.",
  },
  {
    field: "bareBuiltD",
    label: "Bare / built-up — ΔNDBI at least",
    tooltip:
      "NDBI must rise at least this much for “bare / built-up increase”. Lower catches small construction, but also ploughed-soil noise.",
  },
  {
    field: "bareBuiltNdviMax",
    label: "Bare / built-up guard — ΔNDVI at most",
    tooltip:
      "Guard: vegetation must also drop (ΔNDVI at or below this) before anything counts as bare / built-up — dry-soil false alarms stay out.",
  },
];

const ADVANCED_RULES: RuleDef[] = [
  {
    field: "bareBuiltMaxMndwi",
    label: "Bare / built-up max MNDWI",
    tooltip:
      "Bare / built-up is suppressed where MNDWI exceeds this on either date — open-water areas never become “construction”.",
  },
  {
    field: "waterGainMndwiMin",
    label: "Water gain min MNDWI",
    tooltip:
      "After-state gate: MNDWI on date B must exceed this for a water-gain patch (it must actually look like open water).",
  },
  {
    field: "waterLossMndwiMin",
    label: "Water loss min MNDWI",
    tooltip:
      "Before-state gate: MNDWI on date A must exceed this for a water-loss patch (it must have actually been open water).",
  },
];

/** Marker colours follow the change-class palette (classColor values). */
const MARKER_COLORS: Record<number, string> = {
  [CLASS.vegGain]: "rgb(45,164,78)",
  [CLASS.vegLoss]: "rgb(227,99,44)",
  [CLASS.waterGain]: "rgb(56,132,255)",
  [CLASS.waterLoss]: "rgb(226,183,45)",
  [CLASS.bareBuilt]: "rgb(170,70,190)",
};

export default function ThresholdEditor({
  metadata,
  histograms,
  advancedOpen,
  onToggleAdvanced,
}: {
  metadata: CompareMetadata;
  /** The analysed run's histograms (quick runs; absent on detail entries). */
  histograms?: { ndvi: DeltaHistogram; mndwi: DeltaHistogram; ndbi: DeltaHistogram };
  advancedOpen: boolean;
  onToggleAdvanced: () => void;
}) {
  const sensitivity = useCompareStore((s) => s.sensitivity);
  const thresholds = useCompareStore((s) => s.thresholds);
  const thresholdsPreset = useCompareStore((s) => s.thresholdsPreset);
  const setSensitivity = useCompareStore((s) => s.setSensitivity);
  const setThreshold = useCompareStore((s) => s.setThreshold);
  const clearThresholds = useCompareStore((s) => s.clearThresholds);
  const running = useCompareStore((s) => s.running);
  const lockedThresholds = useLocked("compare.thresholds");

  // Text drafts for the numeric inputs (commit on blur / Enter).
  const [drafts, setDrafts] = useState<Partial<Record<ThresholdField, string>>>({});

  // The values the sliders show: the run's overrides, else the preset's.
  const preset = presetThresholds(sensitivity);
  const current: ScaledThresholds = thresholds
    ? { ...preset, ...thresholds }
    : preset;
  const isCustom = thresholds !== null;

  const commit = (field: ThresholdField): void => {
    const draft = drafts[field];
    if (draft === undefined) return;
    const parsed = Number(draft);
    setDrafts((d) => ({ ...d, [field]: undefined }));
    if (draft.trim() !== "" && Number.isFinite(parsed)) {
      setThreshold(field, parsed);
    }
  };

  const ruleRow = (rule: RuleDef) => {
    const bounds = THRESHOLD_BOUNDS[rule.field];
    const value = current[rule.field];
    return (
      <div key={rule.field} className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <Tooltip content={rule.tooltip}>
            <span className="cursor-help border-b border-dotted border-border text-[11px] text-muted">
              {rule.label}
            </span>
          </Tooltip>
          <span className="flex items-center gap-1">
            <input
              type="text"
              inputMode="decimal"
              aria-label={`${rule.label} value`}
              disabled={lockedThresholds}
              value={drafts[rule.field] ?? value.toFixed(2)}
              onFocus={(event) => event.target.select()}
              onChange={(event) => {
                if (lockedThresholds) return;
                setDrafts((d) => ({ ...d, [rule.field]: event.target.value }));
              }}
              onBlur={() => commit(rule.field)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit(rule.field);
              }}
              className="mono-nums w-16 rounded border border-border bg-surface px-1.5 py-0.5 text-right text-[11px] text-text focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:opacity-50"
            />
          </span>
        </div>
        <Slider
          aria-label={`${rule.label} slider`}
          min={bounds.min}
          max={bounds.max}
          step={0.01}
          value={Math.min(bounds.max, Math.max(bounds.min, value))}
          disabled={lockedThresholds || running}
          onChange={(event) => {
            if (lockedThresholds) return;
            setThreshold(rule.field, Number(event.target.value));
          }}
        />
      </div>
    );
  };

  const histogramMarkers = (index: "ndvi" | "mndwi" | "ndbi"): HistogramMarker[] => {
    if (index === "ndvi") {
      return [
        { id: "vegLossD", value: current.vegLossD, ...THRESHOLD_BOUNDS.vegLossD, direction: "below", label: "Veg loss", color: MARKER_COLORS[CLASS.vegLoss] },
        { id: "vegGainD", value: current.vegGainD, ...THRESHOLD_BOUNDS.vegGainD, direction: "above", label: "Veg gain", color: MARKER_COLORS[CLASS.vegGain] },
        { id: "bareBuiltNdviMax", value: current.bareBuiltNdviMax, ...THRESHOLD_BOUNDS.bareBuiltNdviMax, direction: "below", label: "Bare guard", color: MARKER_COLORS[CLASS.bareBuilt] },
      ];
    }
    if (index === "mndwi") {
      return [
        { id: "waterLossD", value: current.waterLossD, ...THRESHOLD_BOUNDS.waterLossD, direction: "below", label: "Water loss", color: MARKER_COLORS[CLASS.waterLoss] },
        { id: "waterGainD", value: current.waterGainD, ...THRESHOLD_BOUNDS.waterGainD, direction: "above", label: "Water gain", color: MARKER_COLORS[CLASS.waterGain] },
      ];
    }
    return [
      { id: "bareBuiltD", value: current.bareBuiltD, ...THRESHOLD_BOUNDS.bareBuiltD, direction: "above", label: "Bare / built-up", color: MARKER_COLORS[CLASS.bareBuilt] },
    ];
  };

  const presetLabel: Record<Sensitivity, string> = {
    low: "Low",
    medium: "Medium",
    high: "High",
    veryhigh: "Very high",
    auto: "Auto",
  };

  return (
    <div className="mt-2 flex flex-col gap-2">
      {/* Preset row — choosing a preset fills the sliders with its values. */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted">Preset</p>
          <span className="flex items-center gap-1.5">
            {isCustom && (
              <span className="rounded-sm border border-warning/40 bg-warning/10 px-1.5 py-px text-[10px] text-text">
                Custom (from {presetLabel[thresholdsPreset]})
              </span>
            )}
            {isCustom && !lockedThresholds && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                title="Drop the custom values and use the preset's thresholds."
                onClick={clearThresholds}
              >
                <RotateCcw size={11} aria-hidden /> Reset to preset
              </Button>
            )}
            <FeatureLock capability="compare.thresholds" label="Adjust thresholds" />
          </span>
        </div>
        <Segmented
          ariaLabel="Threshold preset"
          value={sensitivity}
          onChange={(value) => {
            if (lockedThresholds) return;
            setSensitivity(value as Sensitivity);
            clearThresholds();
          }}
          options={[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "veryhigh", label: "Very high" },
            { value: "auto", label: "Auto" },
          ]}
          className={cn(lockedThresholds && "pointer-events-none opacity-50")}
        />
        <p className="text-[10px] text-muted">
          {lockedThresholds
            ? "Thresholds are preset-only for guests — sign in to fine-tune each rule."
            : "Presets fill the sliders below · any edit makes the run Custom · changes apply only on Re-run"}
        </p>
      </div>

      {/* The six main rules. */}
      <div className="flex flex-col gap-2.5">{MAIN_RULES.map(ruleRow)}</div>

      {/* Live histograms (quick runs carry them on the result). */}
      {histograms ? (
        <div className="flex flex-col gap-2.5 rounded border border-border bg-surface-2 p-2">
          <p className="text-[10px] text-muted">
            Beyond-threshold shares update live (nothing is sent until Re-run). Shares above ~5% usually mean the rule is catching noise.
          </p>
          <ThresholdHistogram
            histogram={histograms.ndvi}
            unit="ΔNDVI distribution"
            markers={histogramMarkers("ndvi")}
            onChange={(id, value) => setThreshold(id as ThresholdField, value)}
            disabled={lockedThresholds}
          />
          <ThresholdHistogram
            histogram={histograms.mndwi}
            unit="ΔMNDWI distribution"
            markers={histogramMarkers("mndwi")}
            onChange={(id, value) => setThreshold(id as ThresholdField, value)}
            disabled={lockedThresholds}
          />
          <ThresholdHistogram
            histogram={histograms.ndbi}
            unit="ΔNDBI distribution"
            markers={histogramMarkers("ndbi")}
            onChange={(id, value) => setThreshold(id as ThresholdField, value)}
            disabled={lockedThresholds}
          />
        </div>
      ) : (
        <p className="text-[10px] text-muted">
          Live histograms are available for Quick runs — the analysed distribution is not cached for detailed block runs.
        </p>
      )}

      {/* Advanced state gates (no histogram — they are gates, not deltas). */}
      <div className="rounded border border-border bg-surface-2 px-2 py-1.5">
        <button
          type="button"
          aria-expanded={advancedOpen}
          onClick={onToggleAdvanced}
          className="flex w-full items-center justify-between gap-2 text-[11px] text-text transition-colors duration-150 hover:text-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          Advanced
          <ChevronDown
            size={13}
            className={cn("text-muted transition-transform duration-150", advancedOpen && "rotate-180")}
            aria-hidden
          />
        </button>
        {advancedOpen && <div className="mt-2 flex flex-col gap-2.5">{ADVANCED_RULES.map(ruleRow)}</div>}
      </div>

      {/* Read-only grid row — grid size is a server decision, never editable. */}
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-muted">Grid size (read-only)</span>
        <span className="mono-nums text-text">
          {metadata.width}×{metadata.height}
        </span>
      </div>
    </div>
  );
}
