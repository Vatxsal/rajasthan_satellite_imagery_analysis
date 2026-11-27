"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark,
  BookmarkPlus,
  Copy,
  Download,
  History,
  MoreHorizontal,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import type { CompositeId, District, Ilr, Tehsil } from "@/lib/data";
import { districtsFc, ilrsFc, resolveDistrictId, tehsilsFc } from "@/lib/data/boundaries";
import { bboxFromGeometry } from "@/lib/cdse/geometry";
import { exampleQueries } from "@/lib/queries/presets";
import { savedQueryInputSchema, isQueryRepoError, type SavedQuery } from "@/lib/queries/repository";
import { inputFromQuery, suggestionOf } from "@/lib/queries/client";
import { currentFiltersDraft } from "./SaveQueryDialog";
import { useAppStore } from "@/store/useAppStore";
import { useCompareStore } from "@/store/useCompareStore";
import { useQueriesStore } from "@/store/useQueriesStore";
import { useLocked } from "@/store/useSession";
import Button from "@/components/ui/Button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/Dialog";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/Menu";
import Select from "@/components/ui/Select";
import { cn } from "@/components/ui/cn";

type SortId = "pinned" | "recent" | "name" | "lastrun";

const SORTS: { id: SortId; label: string }[] = [
  { id: "pinned", label: "Pinned first" },
  { id: "recent", label: "Recently updated" },
  { id: "name", label: "Name A–Z" },
  { id: "lastrun", label: "Last run" },
];

const COMPOSITE_LABELS: Record<CompositeId, string> = {
  "true-color": "True colour",
  "false-color": "False colour",
  ndvi: "NDVI",
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoDayAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function rangeLabel(dateRange: SavedQuery["dateRange"]): string {
  if (dateRange.mode === "relative") return `last ${dateRange.days ?? 90} days`;
  return `${dateRange.from} → ${dateRange.to}`;
}

function relTime(iso: string | null): string {
  if (!iso) return "";
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── area resolution for Run (same rule as share links: leaf must exist,
//    parents chain best-effort through the shared boundary dataset) ─────────

function polygonOf(feature: GeoJSON.Feature): GeoJSON.Polygon | null {
  const geometry = feature.geometry;
  if (!geometry || (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon")) return null;
  return geometry as GeoJSON.Polygon;
}

function districtById(id: string): District | null {
  const resolved = resolveDistrictId(id);
  const feature = districtsFc.features.find((candidate) => candidate.properties?.id === resolved);
  if (!feature) return null;
  const geometry = polygonOf(feature);
  const bbox = geometry ? bboxFromGeometry(geometry) : null;
  if (!geometry || !bbox) return null;
  return {
    id: String(feature.properties?.id ?? resolved),
    name: String(feature.properties?.name ?? resolved),
    geometry,
    bbox,
  };
}

function tehsilById(id: string): Tehsil | null {
  const feature = tehsilsFc.features.find((candidate) => candidate.properties?.id === id);
  if (!feature) return null;
  const geometry = polygonOf(feature);
  const bbox = geometry ? bboxFromGeometry(geometry) : null;
  if (!geometry || !bbox) return null;
  return {
    id: String(feature.properties?.id ?? id),
    name: String(feature.properties?.name ?? id),
    districtId: String(feature.properties?.districtId ?? ""),
    geometry,
    bbox,
  };
}

function ilrById(id: string): Ilr | null {
  const feature = ilrsFc.features.find((candidate) => candidate.properties?.id === id);
  if (!feature) return null;
  const geometry = polygonOf(feature);
  const bbox = geometry ? bboxFromGeometry(geometry) : null;
  if (!geometry || !bbox) return null;
  return {
    id: String(feature.properties?.id ?? id),
    name: String(feature.properties?.name ?? id),
    tehsilId: String(feature.properties?.tehsilId ?? ""),
    districtId: String(feature.properties?.districtId ?? ""),
    geometry,
    bbox,
  };
}

interface ResolvedRunArea {
  district: District | null;
  tehsil: Tehsil | null;
  ilr: Ilr | null;
}

function resolveRunArea(area: SavedQuery["area"]): ResolvedRunArea | null {
  if (area.level === "state") return { district: null, tehsil: null, ilr: null };
  if (area.level === "district") {
    const district = districtById(area.areaId);
    return district ? { district, tehsil: null, ilr: null } : null;
  }
  if (area.level === "tehsil") {
    const tehsil = tehsilById(area.areaId);
    if (!tehsil) return null;
    return { district: districtById(tehsil.districtId), tehsil, ilr: null };
  }
  const ilr = ilrById(area.areaId);
  if (!ilr) return null;
  const tehsil = ilr.tehsilId ? tehsilById(ilr.tehsilId) : null;
  return {
    district: districtById(ilr.districtId || tehsil?.districtId || ""),
    tehsil,
    ilr,
  };
}

function stripQueryMeta(entry: unknown): unknown {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const copy: Record<string, unknown> = { ...(entry as Record<string, unknown>) };
  for (const key of ["id", "createdAt", "updatedAt", "lastRunAt", "runCount"]) delete copy[key];
  return copy;
}

function toastError(error: unknown): void {
  const message = error instanceof Error && error.message ? error.message : "Something went wrong.";
  useAppStore.getState().pushToast({ tone: "error", message });
}

// ── one saved query row ─────────────────────────────────────────────────────

function QueryRow({
  query,
  applied,
  onRun,
}: {
  query: SavedQuery;
  applied: boolean;
  onRun: () => void;
}) {
  const openEdit = useQueriesStore((s) => s.openEdit);
  const update = useQueriesStore((s) => s.update);
  const duplicate = useQueriesStore((s) => s.duplicate);
  const togglePin = useQueriesStore((s) => s.togglePin);

  const updateWithCurrentFilters = () => {
    const draft = currentFiltersDraft();
    void update(query.id, {
      area: draft.area,
      dateRange: draft.dateRange,
      maxCloud: draft.maxCloud,
      composite: draft.composite,
    })
      .then(() =>
        useAppStore.getState().pushToast({
          tone: "success",
          message: `Updated “${query.name}” with the current filters`,
        }),
      )
      .catch(toastError);
  };

  const duplicateQuery = () => {
    void duplicate(query.id)
      .then((copy) =>
        useAppStore.getState().pushToast({
          tone: "success",
          message: `Duplicated as “${copy.name}”`,
        }),
      )
      .catch(toastError);
  };

  const flipPin = () => {
    void togglePin(query.id).catch(toastError);
  };

  return (
    <div
      className={cn(
        "rounded border p-2.5 transition-colors duration-150",
        applied ? "border-accent bg-accent-soft" : "border-border bg-surface",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {query.pinned && <Pin size={11} className="shrink-0 text-accent" aria-label="Pinned" />}
            <p className="truncate text-sm font-medium text-text">{query.name}</p>
          </div>
          <p className="mono-nums mt-0.5 truncate text-xs text-muted">
            {query.area.name} · {rangeLabel(query.dateRange)} · ≤{query.maxCloud}% ·{" "}
            {COMPOSITE_LABELS[query.composite]}
          </p>
          {query.runCount > 0 && (
            <p className="mono-nums mt-0.5 truncate text-[11px] text-muted">
              Ran {query.runCount}× · {relTime(query.lastRunAt)}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant={applied ? "primary" : "secondary"}
            size="sm"
            className="gap-1.5"
            onClick={onRun}
            aria-label={`Run saved query ${query.name}`}
          >
            {applied ? (
              <>
                <RefreshCw size={13} aria-hidden />
                Applied
              </>
            ) : (
              <>
                <Play size={13} aria-hidden />
                Run
              </>
            )}
          </Button>
          <Menu>
            <MenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Actions for ${query.name}`}>
                <MoreVertical size={15} />
              </Button>
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => openEdit(query)}>
                <Pencil size={13} aria-hidden />
                Edit…
              </MenuItem>
              <MenuItem onSelect={updateWithCurrentFilters}>
                <History size={13} aria-hidden />
                Update with current filters
              </MenuItem>
              <MenuItem onSelect={duplicateQuery}>
                <Copy size={13} aria-hidden />
                Duplicate
              </MenuItem>
              <MenuItem onSelect={flipPin}>
                {query.pinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}
                {query.pinned ? "Unpin" : "Pin"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                className="text-danger data-[highlighted]:bg-danger/10"
                onSelect={() => useQueriesStore.getState().requestDelete(query)}
              >
                <Trash2 size={13} aria-hidden />
                Delete…
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
    </div>
  );
}

// ── panel ───────────────────────────────────────────────────────────────────

export default function SavedQueriesPanel() {
  const status = useQueriesStore((s) => s.status);
  const error = useQueriesStore((s) => s.error);
  const items = useQueriesStore((s) => s.items);
  const config = useQueriesStore((s) => s.config);
  const appliedId = useQueriesStore((s) => s.appliedId);
  const setApplied = useQueriesStore((s) => s.setApplied);
  const lockedCompare = useLocked("compare.adjust-sensitivity");

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortId>("pinned");
  const [addingExamples, setAddingExamples] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void useQueriesStore.getState().load();
  }, []);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = needle
      ? items.filter((query) =>
          [query.name, query.description, query.area.name].some((value) =>
            value.toLowerCase().includes(needle),
          ),
        )
      : items;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "lastrun") return (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "");
      if (sort === "recent") return b.updatedAt.localeCompare(a.updatedAt);
      // pinned first
      return Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt);
    });
    return sorted;
  }, [items, search, sort]);

  const runQuery = (query: SavedQuery) => {
    const app = useAppStore.getState();
    const area = resolveRunArea(query.area);
    if (!area) {
      app.pushToast({
        tone: "error",
        message: "This query's area is no longer available. Edit the query to pick a new one.",
      });
      return;
    }
    app.setDistrict(area.district);
    if (area.tehsil) app.setTehsil(area.tehsil);
    if (area.ilr) app.setIlr(area.ilr);

    if (query.dateRange.mode === "relative") {
      app.setFromDate(isoDayAgo(query.dateRange.days ?? 90));
      app.setToDate(todayIso());
    } else {
      app.setFromDate(query.dateRange.from);
      app.setToDate(query.dateRange.to);
    }
    app.setMaxCloudCover(query.maxCloud);
    app.setComposite(query.composite);

    if (query.compare && !lockedCompare) {
      const compare = useCompareStore.getState();
      compare.setSensitivity(query.compare.sensitivity);
      compare.setMinPatchHa(query.compare.minPatchHa);
      // Phase-thresholds: apply the saved overrides (null = presets).
      compare.replaceThresholds(query.compare.thresholds ?? null);
    }

    setApplied(query.id);
    app.setSidebarTab("filters");
    void useQueriesStore.getState().touchRun(query.id);
    void app.runSearch();
  };


  const addExamples = () => {
    const examples = exampleQueries();
    if (examples.length === 0) return;
    setAddingExamples(true);
    void (async () => {
      const { create } = useQueriesStore.getState();
      let added = 0;
      let limited = false;
      let failed = false;
      for (const input of examples) {
        try {
          await create(input);
          added += 1;
        } catch (err) {
          if (isQueryRepoError(err) && err.code === "LIMIT_REACHED") {
            limited = true;
            break;
          }
          if (isQueryRepoError(err) && err.code === "NAME_TAKEN") continue; // already there
          failed = true;
          break;
        }
      }
      setAddingExamples(false);
      const toast = useAppStore.getState().pushToast;
      if (failed) {
        toast({ tone: "error", message: "Could not add the example queries." });
      } else if (added === 0 && limited) {
        toast({ tone: "info", message: "You have reached your saved-query limit." });
      } else if (added < examples.length) {
        toast({
          tone: "success",
          message: `Added ${added} of ${examples.length} example queries — limit reached.`,
        });
      } else {
        toast({ tone: "success", message: `Added ${added} example queries.` });
      }
    })();
  };

  const exportQueries = () => {
    if (items.length === 0) {
      useAppStore.getState().pushToast({ tone: "info", message: "Nothing to export yet." });
      return;
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      queries: items,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `saved-queries-${todayIso()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    useAppStore.getState().pushToast({
      tone: "success",
      message: `Exported ${items.length} ${items.length === 1 ? "query" : "queries"}.`,
    });
  };

  const importQueries = async (file: File) => {
    setImporting(true);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        useAppStore.getState().pushToast({
          tone: "error",
          message: "That file is not valid JSON.",
        });
        return;
      }
      const raw = Array.isArray(parsed)
        ? parsed
        : ((parsed as { queries?: unknown } | null)?.queries ?? null);
      if (!Array.isArray(raw)) {
        useAppStore.getState().pushToast({
          tone: "error",
          message: "That file doesn't contain a list of saved queries.",
        });
        return;
      }

      const { create } = useQueriesStore.getState();
      let imported = 0;
      let skipped = 0;
      let limited = false;
      let broke = false;

      for (const entry of raw) {
        const candidate = savedQueryInputSchema.safeParse(stripQueryMeta(entry));
        if (!candidate.success) {
          skipped += 1;
          continue;
        }
        try {
          await create(candidate.data);
          imported += 1;
        } catch (err) {
          if (isQueryRepoError(err) && err.code === "NAME_TAKEN") {
            const suggestion = suggestionOf(err);
            if (suggestion) {
              try {
                await create({ ...candidate.data, name: suggestion });
                imported += 1;
                continue;
              } catch {
                skipped += 1;
                continue;
              }
            }
            skipped += 1;
            continue;
          }
          if (isQueryRepoError(err) && err.code === "LIMIT_REACHED") {
            limited = true;
            break;
          }
          broke = true;
          break;
        }
      }

      const toast = useAppStore.getState().pushToast;
      if (broke && imported === 0) {
        toast({ tone: "error", message: "Import failed — saved-query storage is unavailable." });
      } else if (imported === 0 && !limited) {
        toast({ tone: "error", message: `No valid queries found in ${file.name}.` });
      } else {
        const parts = [`Imported ${imported} of ${raw.length}`];
        if (skipped > 0) parts.push(`${skipped} skipped`);
        if (limited) parts.push("limit reached");
        toast({ tone: imported > 0 ? "success" : "info", message: `${parts.join(" · ")}.` });
      }
    } finally {
      setImporting(false);
    }
  };

  const loading = status === "loading" && items.length === 0;
  const failed = status === "error";
  const max = config?.limits.max;

  return (
    <div className="space-y-3 p-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importQueries(file);
          event.target.value = "";
        }}
      />

      {/* -------------------------------------------------- search + sort */}
      <div className="flex gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted"
            aria-hidden
          />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search saved queries"
            aria-label="Search saved queries"
            className="h-8 w-full rounded border border-border bg-surface pl-7 pr-2 text-sm text-text transition-colors duration-150 hover:border-muted focus:border-accent focus:outline-none"
          />
        </div>
        <div className="w-36 shrink-0">
          <Select
            value={sort}
            aria-label="Sort saved queries"
            onChange={(event) => setSort(event.target.value as SortId)}
          >
            {SORTS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* --------------------------------------------------- meta + menu */}
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11px] text-muted">
          {items.length}
          {max !== undefined ? ` of ${max}` : ""} saved ·{" "}
          {config?.store === "local" ? "this browser" : "synced to your account"}
        </p>
        <Menu>
          <MenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Saved query options">
              <MoreHorizontal size={15} />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={exportQueries} disabled={items.length === 0}>
              <Download size={13} aria-hidden />
              Export as JSON
            </MenuItem>
            <MenuItem onSelect={() => fileInputRef.current?.click()} disabled={importing}>
              <Upload size={13} aria-hidden />
              {importing ? "Importing…" : "Import from JSON…"}
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>

      {/* ------------------------------------------------------- states */}
      {loading && (
        <div className="space-y-2" role="status" aria-label="Loading saved queries">
          <div className="h-16 animate-pulse rounded border border-border bg-surface-2" />
          <div className="h-16 animate-pulse rounded border border-border bg-surface-2" />
          <div className="h-16 animate-pulse rounded border border-border bg-surface-2" />
        </div>
      )}

      {failed && (
        <div className="rounded border border-danger/50 bg-danger/10 p-3">
          <p className="text-sm text-danger">{error ?? "Saved queries are unavailable."}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            onClick={() => void useQueriesStore.getState().load()}
          >
            <RefreshCw size={13} aria-hidden />
            Retry
          </Button>
        </div>
      )}

      {!loading && !failed && items.length === 0 && (
        <div className="rounded border border-dashed border-border bg-surface px-3 py-6 text-center">
          <Bookmark size={18} className="mx-auto mb-2 text-muted" aria-hidden />
          <p className="text-sm font-medium text-text">No saved queries yet</p>
          <p className="mt-1 text-xs leading-snug text-muted">
            Save your current filters from the Filters tab, or start from a template.
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={addingExamples}
            onClick={addExamples}
          >
            <BookmarkPlus size={13} aria-hidden />
            {addingExamples ? "Adding…" : "Add example queries"}
          </Button>
        </div>
      )}

      {!failed && items.length > 0 && visible.length === 0 && (
        <div className="rounded border border-border bg-surface px-3 py-4 text-center">
          <p className="text-sm text-muted">
            {search.trim() ? `No queries match “${search.trim()}”.` : "Nothing to show."}
          </p>
          {search.trim() && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setSearch("")}>
              Clear search
            </Button>
          )}
        </div>
      )}

      {/* -------------------------------------------------------- the list */}
      {visible.map((query) => (
        <QueryRow
          key={query.id}
          query={query}
          applied={appliedId === query.id}
          onRun={() => runQuery(query)}
        />
      ))}

      <DeleteConfirm />
    </div>
  );
}

/** Confirm dialog fed by useQueriesStore.requestDelete (also menu-driven). */
function DeleteConfirm() {
  const pending = useQueriesStore((s) => s.deleteTarget);
  const remove = useQueriesStore((s) => s.remove);
  const restore = useQueriesStore((s) => s.restore);
  const storeKind = useQueriesStore((s) => s.config?.store ?? null);
  const close = useQueriesStore((s) => s.closeDelete);
  if (!pending) return null;

  const confirm = () => {
    const input = inputFromQuery(pending);
    void remove(pending.id)
      .then(() => {
        close();
        useAppStore.getState().pushToast({
          tone: "info",
          message: `Deleted “${pending.name}”`,
          duration: 10_000,
          action: {
            label: "Undo",
            onClick: () => {
              void restore(input)
                .then((restored) =>
                  useAppStore.getState().pushToast({
                    tone: "success",
                    message: `Restored “${restored.name}”`,
                  }),
                )
                .catch(toastError);
            },
          },
        });
      })
      .catch((error: unknown) => {
        close();
        toastError(error);
      });
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent>
        <DialogTitle>Delete saved query?</DialogTitle>
        <DialogDescription>
          “{pending.name}” will be removed{" "}
          {storeKind === "local" ? "from this browser" : "from your account"}. You can undo right
          after deleting.
        </DialogDescription>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm}>
            <Trash2 size={13} aria-hidden />
            Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
