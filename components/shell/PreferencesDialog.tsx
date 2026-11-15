"use client";

import { useEffect, useState } from "react";
import { Lock, RotateCcw, Trash2 } from "lucide-react";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import Slider from "@/components/ui/Slider";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { useLocked } from "@/components/ui/FeatureLock";
import { cn } from "@/components/ui/cn";
import { usePreferencesStore } from "@/store/usePreferencesStore";
import { useTheme } from "@/store/useTheme";

interface PreferencesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function Section({
  id,
  title,
  helper,
  children,
}: {
  id: string;
  title: string;
  helper?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-2.5">
      <h3 id={id} className="section-label">
        {title}
      </h3>
      {children}
      {helper && <p className="text-[11px] leading-snug text-muted">{helper}</p>}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-text">{label}</p>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted">{hint}</p>}
    </div>
  );
}

function LockedNote({ title }: { title: string }) {
  return (
    <div className="rounded border border-border bg-surface-2 px-2.5 py-2">
      <p className="flex items-center gap-1.5 text-xs font-medium text-text">
        <Lock size={12} className="shrink-0 text-muted" aria-hidden />
        Available with an SSO ID
      </p>
      <p className="mt-0.5 text-[11px] leading-snug text-muted">
        {title} is part of the full-access SSO session. Guests browse with tighter limits.
      </p>
    </div>
  );
}

const BOOL_OPTIONS: Array<{ value: "on" | "off"; label: string }> = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

/**
 * Settings dialog from the top-right menu. Every control instant-applies via
 * setSection (persisted per account in this browser) — there is deliberately
 * no Save button. Appearance applies immediately (root font size / reduced
 * motion); map defaults are re-applied at app start or Home reset. Change and
 * report preferences are SSO-only, matching the capabilities the server
 * enforces; guests see the locked sections in place.
 */
export default function PreferencesDialog({ open, onOpenChange }: PreferencesDialogProps) {
  const values = usePreferencesStore((s) => s.values);
  const storageOk = usePreferencesStore((s) => s.storageOk);
  const setSection = usePreferencesStore((s) => s.setSection);
  const resetToDefaults = usePreferencesStore((s) => s.resetToDefaults);
  const clearSaved = usePreferencesStore((s) => s.clearSaved);
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const lockedChange = useLocked("compare.adjust-sensitivity");
  const lockedReports = useLocked("email.report");

  const [confirmClear, setConfirmClear] = useState(false);
  const [recipientHint, setRecipientHint] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setConfirmClear(false);
  }, [open]);

  useEffect(() => {
    if (!open || lockedReports) return;
    let alive = true;
    fetch("/api/compare/email/config")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: unknown) => {
        const hint =
          payload && typeof payload === "object" && "recipientHint" in payload
            ? (payload as { recipientHint: unknown }).recipientHint
            : null;
        if (alive && typeof hint === "string") setRecipientHint(hint);
      })
      .catch(() => {
        // No hint is fine — the section still explains the report options.
      });
    return () => {
      alive = false;
    };
  }, [open, lockedReports]);

  const units = values.units;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Preferences</DialogTitle>
        <DialogDescription>
          Saved in this browser on this device — nothing is sent to the server.
        </DialogDescription>

        <div className="mt-4 space-y-5">
          {/* ---------------------------------------------------- appearance */}
          <Section id="prefs-appearance" title="Appearance">
            <Field label="Theme">
              <Segmented
                ariaLabel="Theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </Field>
            <Field label="Text size" hint="Scales the whole interface.">
              <Segmented
                ariaLabel="Text size"
                value={values.appearance.textSize}
                onChange={(textSize) => setSection("appearance", { textSize })}
                options={[
                  { value: "100", label: "100%" },
                  { value: "110", label: "110%" },
                  { value: "125", label: "125%" },
                ]}
              />
            </Field>
            <Field
              label="Reduce animations"
              hint="System follows your device's motion setting."
            >
              <Segmented
                ariaLabel="Reduce animations"
                value={values.appearance.reduceAnimations}
                onChange={(reduceAnimations) => setSection("appearance", { reduceAnimations })}
                options={[
                  { value: "system", label: "System" },
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
              />
            </Field>
          </Section>

          {/* ---------------------------------------------------- map defaults */}
          <Section
            id="prefs-map"
            title="Map defaults"
            helper="Applied when the app starts or after Home; the current session keeps its live filters until then."
          >
            <Field label="Basemap">
              <Segmented
                ariaLabel="Default basemap"
                value={values.map.basemap}
                onChange={(basemap) => setSection("map", { basemap })}
                options={[
                  { value: "streets", label: "Streets" },
                  { value: "satellite", label: "Satellite" },
                ]}
              />
            </Field>
            <Field label="Composite">
              <Segmented
                ariaLabel="Default composite"
                value={values.map.composite}
                onChange={(composite) => setSection("map", { composite })}
                options={[
                  { value: "true-color", label: "True colour" },
                  { value: "false-color", label: "False colour" },
                  { value: "ndvi", label: "NDVI" },
                ]}
              />
            </Field>
            <Field label="Date range">
              <Segmented
                ariaLabel="Default date range"
                value={values.map.dateRange}
                onChange={(dateRange) => setSection("map", { dateRange })}
                options={[
                  { value: "30d", label: "Last 30 days" },
                  { value: "90d", label: "Last 90 days" },
                  { value: "6m", label: "Last 6 months" },
                ]}
              />
            </Field>
            <Field label={`Maximum cloud cover · ${values.map.maxCloudCover}%`}>
              <Slider
                min={0}
                max={100}
                step={5}
                value={values.map.maxCloudCover}
                aria-label="Default maximum cloud cover percent"
                onChange={(event) => setSection("map", { maxCloudCover: Number(event.target.value) })}
              />
            </Field>
            <Field label={`Overlay opacity · ${Math.round(values.map.overlayOpacity * 100)}%`}>
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={values.map.overlayOpacity}
                aria-label="Default overlay opacity"
                onChange={(event) => setSection("map", { overlayOpacity: Number(event.target.value) })}
              />
            </Field>
            <Field label="Boost visibility">
              <Segmented
                ariaLabel="Boost visibility"
                value={values.map.boostVisibility ? "on" : "off"}
                onChange={(next) => setSection("map", { boostVisibility: next === "on" })}
                options={BOOL_OPTIONS}
              />
            </Field>
          </Section>

          {/* ---------------------------------------------------- units/format */}
          <Section id="prefs-units" title="Units and format">
            <Field label="Area">
              <Segmented
                ariaLabel="Area unit"
                value={units.areaUnit}
                onChange={(areaUnit) => setSection("units", { areaUnit })}
                options={[
                  { value: "ha", label: "Hectares (ha)" },
                  { value: "km2", label: "Square km (km²)" },
                  { value: "acre", label: "Acres (ac)" },
                ]}
              />
            </Field>
            <Field
              label="Coordinates"
              hint={`Map readout example: ${
                units.coordinates === "dms" ? `17° 7' 24.2" N  75° 7' 24.2" E` : "17.1234° N  75.1234° E"
              }`}
            >
              <Segmented
                ariaLabel="Coordinate format"
                value={units.coordinates}
                onChange={(coordinates) => setSection("units", { coordinates })}
                options={[
                  { value: "dd", label: "Decimal degrees" },
                  { value: "dms", label: "Deg · min · sec" },
                ]}
              />
            </Field>
            <Field label="Time zone" hint="Used for session and report timestamps.">
              <Segmented
                ariaLabel="Time zone"
                value={units.timeZone}
                onChange={(timeZone) => setSection("units", { timeZone })}
                options={[
                  { value: "ist", label: "IST (UTC+05:30)" },
                  { value: "utc", label: "UTC" },
                ]}
              />
            </Field>
            <Field label="Date format" hint="Applies to scene dates.">
              <Segmented
                ariaLabel="Date format"
                value={units.dateFormat}
                onChange={(dateFormat) => setSection("units", { dateFormat })}
                options={[
                  { value: "dd-mon-yyyy", label: "05 Jan 2026" },
                  { value: "dd-mm-yyyy", label: "05-01-2026" },
                  { value: "yyyy-mm-dd", label: "2026-01-05" },
                ]}
              />
            </Field>
          </Section>

          {/* ---------------------------------------------------- change detection */}
          <Section
            id="prefs-change"
            title="Change detection"
            helper={
              lockedChange
                ? undefined
                : "New analyses use these defaults; a running analysis keeps the values it started with."
            }
          >
            {lockedChange && <LockedNote title="Change detection preferences" />}
            <fieldset disabled={lockedChange} className={cn("space-y-2.5", lockedChange && "opacity-60")}>
              <Field label="Sensitivity">
                <Segmented
                  ariaLabel="Sensitivity"
                  value={values.change.sensitivity}
                  onChange={(sensitivity) => setSection("change", { sensitivity })}
                  options={[
                    { value: "low", label: "Low" },
                    { value: "medium", label: "Medium" },
                    { value: "high", label: "High" },
                  ]}
                />
              </Field>
              <Field label={`Minimum patch size · ${values.change.minPatchHa} ha`}>
                <Slider
                  min={0.01}
                  max={100}
                  step={0.01}
                  value={values.change.minPatchHa}
                  aria-label="Default minimum patch size in hectares"
                  onChange={(event) => setSection("change", { minPatchHa: Number(event.target.value) })}
                />
              </Field>
            </fieldset>
          </Section>

          {/* ---------------------------------------------------- reports */}
          <Section id="prefs-reports" title="Reports">
            {lockedReports && <LockedNote title="Report preferences" />}
            <fieldset disabled={lockedReports} className={cn("space-y-2.5", lockedReports && "opacity-60")}>
              <Field label="Language">
                <Segmented
                  ariaLabel="Report language"
                  value={values.reports.language}
                  onChange={(language) => setSection("reports", { language })}
                  options={[
                    { value: "en", label: "English" },
                    { value: "hi", label: "हिन्दी" },
                  ]}
                />
              </Field>
              <Field label="AI summary in the report">
                <Segmented
                  ariaLabel="Include AI summary"
                  value={values.reports.includeSummary ? "on" : "off"}
                  onChange={(next) => setSection("reports", { includeSummary: next === "on" })}
                  options={BOOL_OPTIONS}
                />
              </Field>
              <Field label="Change image in the report">
                <Segmented
                  ariaLabel="Include change image"
                  value={values.reports.includeImage ? "on" : "off"}
                  onChange={(next) => setSection("reports", { includeImage: next === "on" })}
                  options={BOOL_OPTIONS}
                />
              </Field>
              {!lockedReports && recipientHint && (
                <p className="text-[11px] leading-snug text-muted">
                  Reports are delivered to{" "}
                  <span className="mono-nums font-medium text-text">{recipientHint}</span>.
                </p>
              )}
            </fieldset>
          </Section>

          {/* ---------------------------------------------------- data */}
          <Section
            id="prefs-data"
            title="Data"
            helper="Statistics, exports, and emails always use canonical units (hectares) and UTC — these settings change the interface only."
          >
            <p className="text-[11px] leading-snug text-muted">
              {storageOk
                ? "Preferences are saved in this browser for your account only."
                : "Browser storage is unavailable — preferences apply for this session only."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={resetToDefaults}>
                <RotateCcw size={13} aria-hidden />
                Reset to defaults
              </Button>
              {confirmClear ? (
                <span className="flex items-center gap-2">
                  <Button type="button" variant="danger" size="sm" onClick={() => {
                    clearSaved();
                    setConfirmClear(false);
                  }}>
                    <Trash2 size={13} aria-hidden />
                    Yes, clear everything
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
                    Keep
                  </Button>
                </span>
              ) : (
                <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmClear(true)}>
                  <Trash2 size={13} aria-hidden />
                  Clear saved data
                </Button>
              )}
            </div>
            {confirmClear && (
              <p className="text-[11px] text-muted">Clear all saved preferences for this account?</p>
            )}
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
