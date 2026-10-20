"use client";

import { RotateCcw, Search } from "lucide-react";
import type { CompositeId } from "@/lib/data";
import { COMPOSITE_OPTIONS } from "@/lib/data/composites";
import { useDistricts, useIlrs, useTehsils } from "@/lib/hooks/useAreas";
import { useAppStore } from "@/store/useAppStore";
import Button from "@/components/ui/Button";
import Segmented from "@/components/ui/Segmented";
import Select from "@/components/ui/Select";
import Slider from "@/components/ui/Slider";
import DateCalendar from "./DateCalendar";

type DatePresetId = "30d" | "90d" | "6m" | "custom";

const DATE_PRESETS: { id: Exclude<DatePresetId, "custom">; label: string; days: number }[] = [
  { id: "30d", label: "30d", days: 30 },
  { id: "90d", label: "90d", days: 90 },
  { id: "6m", label: "6m", days: 182 },
];

function isoDayAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function FiltersPanel() {
  const districtsState = useDistricts();

  const districtId = useAppStore((s) => s.districtId);
  const tehsilId = useAppStore((s) => s.tehsilId);
  const ilrId = useAppStore((s) => s.ilrId);
  const fromDate = useAppStore((s) => s.fromDate);
  const toDate = useAppStore((s) => s.toDate);
  const maxCloudCover = useAppStore((s) => s.maxCloudCover);
  const composite = useAppStore((s) => s.composite);
  const searching = useAppStore((s) => s.searching);

  const setDistrict = useAppStore((s) => s.setDistrict);
  const setTehsil = useAppStore((s) => s.setTehsil);
  const setIlr = useAppStore((s) => s.setIlr);
  const setFromDate = useAppStore((s) => s.setFromDate);
  const setToDate = useAppStore((s) => s.setToDate);
  const setMaxCloudCover = useAppStore((s) => s.setMaxCloudCover);
  const setComposite = useAppStore((s) => s.setComposite);
  const runSearch = useAppStore((s) => s.runSearch);
  const clearFilters = useAppStore((s) => s.clearFilters);
  const setCalendarMonth = useAppStore((s) => s.setCalendarMonth);

  const tehsilsState = useTehsils(districtId);
  const ilrsState = useIlrs(tehsilId);

  const districts = districtsState.data ?? [];
  const tehsils = tehsilsState.data ?? [];
  const ilrs = ilrsState.data ?? [];

  const activePreset: DatePresetId =
    DATE_PRESETS.find(
      (preset) => fromDate === isoDayAgo(preset.days) && toDate === todayIso(),
    )?.id ?? "custom";

  const applyPreset = (preset: DatePresetId) => {
    if (preset === "custom") {
      // Custom mode = available-dates calendar; drop any pinned view month.
      setCalendarMonth(null);
      return;
    }
    const def = DATE_PRESETS.find((p) => p.id === preset);
    if (!def) return;
    setFromDate(isoDayAgo(def.days));
    setToDate(todayIso());
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="space-y-6 p-3 pb-4">
        {/* ---------------------------------------------------------- area */}
        <section className="space-y-3">
          <h3 className="section-label">Area</h3>

          <div>
            <label className="mb-1 block text-sm text-muted" htmlFor="filter-district">
              District
            </label>
            {districtsState.loading ? (
              <Select disabled placeholder="Loading…" value="" onChange={() => undefined} />
            ) : (
              <Select
                id="filter-district"
                value={districtId ?? ""}
                placeholder="All Rajasthan"
                onChange={(event) => {
                  const value = event.target.value;
                  setDistrict(districts.find((d) => d.id === value) ?? null);
                }}
              >
                {districts.map((district) => (
                  <option key={district.id} value={district.id}>
                    {district.name}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {districtId && (
            <div>
              <label className="mb-1 block text-sm text-muted" htmlFor="filter-tehsil">
                Tehsil
              </label>
              {tehsilsState.loading ? (
                <Select disabled placeholder="Loading…" value="" onChange={() => undefined} />
              ) : (
                <Select
                  id="filter-tehsil"
                  value={tehsilId ?? ""}
                  placeholder="All tehsils"
                  onChange={(event) => {
                    const value = event.target.value;
                    setTehsil(tehsils.find((t) => t.id === value) ?? null);
                  }}
                >
                  {tehsils.map((tehsil) => (
                    <option key={tehsil.id} value={tehsil.id}>
                      {tehsil.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}

          {tehsilId && ilrs.length > 0 && (
            <div>
              <label className="mb-1 block text-sm text-muted" htmlFor="filter-ilr">
                ILR unit
              </label>
              {ilrsState.loading ? (
                <Select disabled placeholder="Loading…" value="" onChange={() => undefined} />
              ) : (
                <Select
                  id="filter-ilr"
                  value={ilrId ?? ""}
                  placeholder="All ILRs"
                  onChange={(event) => {
                    const value = event.target.value;
                    setIlr(ilrs.find((i) => i.id === value) ?? null);
                  }}
                >
                  {ilrs.map((ilr) => (
                    <option key={ilr.id} value={ilr.id}>
                      {ilr.name}
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}
        </section>

        {/* ---------------------------------------------------- date range */}
        <section className="space-y-3">
          <h3 className="section-label">Date range</h3>
          <div className="flex gap-1">
            {DATE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => applyPreset(preset.id)}
                aria-pressed={activePreset === preset.id}
                className={`h-7 rounded border px-2.5 text-sm transition-colors duration-150 ${
                  activePreset === preset.id
                    ? "border-accent bg-accent-soft font-medium text-accent"
                    : "border-border bg-surface text-muted hover:text-text"
                }`}
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              aria-pressed={activePreset === "custom"}
              onClick={() => applyPreset("custom")}
              className={`h-7 rounded border px-2.5 text-sm transition-colors duration-150 ${
                activePreset === "custom"
                  ? "border-accent bg-accent-soft font-medium text-accent"
                  : "border-border bg-surface text-muted hover:text-text"
              }`}
            >
              Calendar
            </button>
          </div>
          {activePreset === "custom" ? (
            <DateCalendar />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="mb-1 block text-sm text-muted" htmlFor="filter-from">
                  From
                </label>
                <input
                  id="filter-from"
                  type="date"
                  value={fromDate}
                  max={toDate}
                  onChange={(event) => setFromDate(event.target.value)}
                  className="mono-nums h-8 w-full rounded border border-border bg-surface px-2 text-sm text-text transition-colors duration-150 hover:border-muted"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted" htmlFor="filter-to">
                  To
                </label>
                <input
                  id="filter-to"
                  type="date"
                  value={toDate}
                  min={fromDate}
                  onChange={(event) => setToDate(event.target.value)}
                  className="mono-nums h-8 w-full rounded border border-border bg-surface px-2 text-sm text-text transition-colors duration-150 hover:border-muted"
                />
              </div>
            </div>
          )}
        </section>

        {/* ---------------------------------------------------- cloud cover */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="section-label">Cloud cover</h3>
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={maxCloudCover}
                aria-label="Maximum cloud cover percent"
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (Number.isNaN(next)) return;
                  setMaxCloudCover(Math.min(100, Math.max(0, next)));
                }}
                className="mono-nums h-7 w-14 rounded border border-border bg-surface px-1.5 text-right text-sm text-text"
              />
              <span className="text-sm text-muted">%</span>
            </div>
          </div>
          <Slider
            min={0}
            max={100}
            step={5}
            value={maxCloudCover}
            aria-label="Maximum cloud cover"
            onChange={(event) => setMaxCloudCover(Number(event.target.value))}
          />
        </section>

        {/* ------------------------------------------------------- composite */}
        <section className="space-y-2">
          <h3 className="section-label">Composite</h3>
          <Segmented
            ariaLabel="Band composite"
            value={composite}
            onChange={(value) => setComposite(value as CompositeId)}
            options={COMPOSITE_OPTIONS.map((option) => ({
              value: option.id,
              label:
                option.id === "true-color"
                  ? "True colour"
                  : option.id === "false-color"
                    ? "False colour"
                    : "NDVI",
            }))}
          />
        </section>
      </div>

      {/* -------------------------------------------------------- actions */}
      <div className="sticky bottom-0 mt-auto border-t border-border bg-surface p-3">
        <div className="flex gap-2">
          <Button
            variant="primary"
            className="flex-1"
            disabled={searching}
            onClick={() => void runSearch()}
          >
            {searching ? (
              "Searching…"
            ) : (
              <>
                <Search size={14} />
                Search imagery
              </>
            )}
          </Button>
          <Button variant="ghost" onClick={clearFilters} aria-label="Reset filters">
            <RotateCcw size={14} />
            Reset
          </Button>
        </div>
      </div>
    </div>
  );
}
