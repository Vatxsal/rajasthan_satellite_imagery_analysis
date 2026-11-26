import { create } from "zustand";
import { z } from "zod";

/**
 * Per-browser preferences, saved in this browser only — never tokens, hashes
 * or any secret (the schema below is the complete stored shape).
 *
 * Storage key: `rie:prefs:v1:<subject>` where subject is the SSO username
 * (or "guest"), so guest and SSO preferences never mix. Reads/writes are
 * wrapped in try/catch: when storage is unavailable the store keeps values
 * in memory and reports `storageOk: false` (the dialog shows a small notice).
 * Storage events keep open tabs in sync; an external event never re-writes.
 */

export const PREFS_STORAGE_PREFIX = "rie:prefs:v1:";

export type PreferenceSectionKey = "appearance" | "map" | "units" | "change" | "reports";

const AppearanceSchema = z.object({
  reduceAnimations: z.enum(["system", "on", "off"]).default("system"),
  textSize: z.enum(["100", "110", "125"]).default("100"),
});

const MapPrefsSchema = z.object({
  basemap: z.enum(["streets", "satellite"]).default("streets"),
  composite: z.enum(["true-color", "false-color", "ndvi"]).default("true-color"),
  dateRange: z.enum(["30d", "90d", "6m"]).default("90d"),
  maxCloudCover: z.number().min(0).max(100).default(20),
  overlayOpacity: z.number().min(0).max(1).default(0.85),
  boostVisibility: z.boolean().default(true),
});

const UnitsSchema = z.object({
  areaUnit: z.enum(["ha", "km2", "acre"]).default("ha"),
  coordinates: z.enum(["dd", "dms"]).default("dd"),
  timeZone: z.enum(["ist", "utc"]).default("ist"),
  dateFormat: z.enum(["dd-mm-yyyy", "yyyy-mm-dd", "dd-mon-yyyy"]).default("dd-mon-yyyy"),
});

const ChangeSchema = z.object({
  sensitivity: z.enum(["low", "medium", "high", "veryhigh", "auto"]).default("medium"),
  minPatchHa: z.number().min(0.01).max(100).default(0.05),
});

const ReportsSchema = z.object({
  language: z.enum(["en", "hi"]).default("en"),
  includeSummary: z.boolean().default(true),
  includeImage: z.boolean().default(true),
});

export const PreferencesSchema = z.object({
  version: z.literal(1),
  appearance: AppearanceSchema.default({}),
  map: MapPrefsSchema.default({}),
  units: UnitsSchema.default({}),
  change: ChangeSchema.default({}),
  reports: ReportsSchema.default({}),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

function defaultSection<S extends z.ZodTypeAny>(schema: S): z.infer<S> {
  return schema.parse({});
}

/**
 * Versioned migration with a safe fallback: unknown versions and corrupt
 * payloads collapse to defaults; a partial v1 payload keeps every valid
 * section and re-fills invalid ones from defaults (section-wise safeParse).
 */
export function migratePreferences(raw: unknown): Preferences {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1) {
    // Future/corrupt version — no upgrade path known, start clean.
    return {
      version: 1,
      appearance: defaultSection(AppearanceSchema),
      map: defaultSection(MapPrefsSchema),
      units: defaultSection(UnitsSchema),
      change: defaultSection(ChangeSchema),
      reports: defaultSection(ReportsSchema),
    };
  }
  const section = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> => {
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : defaultSection(schema);
  };
  return {
    version: 1,
    appearance: section(AppearanceSchema, record.appearance),
    map: section(MapPrefsSchema, record.map),
    units: section(UnitsSchema, record.units),
    change: section(ChangeSchema, record.change),
    reports: section(ReportsSchema, record.reports),
  };
}

/** Storage probe that tolerates privacy modes (access can throw). */
function storageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const probe = `${PREFS_STORAGE_PREFIX}__probe__`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function loadValues(subject: string): Preferences {
  if (!storageAvailable()) return migratePreferences({ version: 1 });
  try {
    const text = window.localStorage.getItem(PREFS_STORAGE_PREFIX + subject);
    if (text === null) return migratePreferences({ version: 1 });
    return migratePreferences(JSON.parse(text) as unknown);
  } catch {
    // Corrupt JSON or a read error: defaults, storage still considered usable.
    return migratePreferences({ version: 1 });
  }
}

function persist(subject: string, values: Preferences, ok: boolean): void {
  if (!ok) return;
  try {
    window.localStorage.setItem(PREFS_STORAGE_PREFIX + subject, JSON.stringify(values));
  } catch {
    // Quota/full: fall back to memory for the rest of the session.
  }
}

/** Patch one section without widening the computed key (typed in, unknown out). */
function withSection<K extends PreferenceSectionKey>(
  values: Preferences,
  key: K,
  patch: Partial<Preferences[K]>,
): Preferences {
  const next: Record<string, unknown> = { ...values };
  next[key] = { ...(values[key] as Record<string, unknown>), ...patch };
  return next as Preferences;
}

interface PreferencesState {
  /** Storage-key subject: the SSO username or "guest". */
  subject: string;
  values: Preferences;
  /** false → in-memory only; the dialog shows the "saved in this browser" notice variant. */
  storageOk: boolean;
  /** Re-read storage for a different subject (login/logout). Same subject = no-op. */
  setSubject: (subject: string) => void;
  /** Instant-apply patch of one section; persists (unless storage is unavailable). */
  setSection: <K extends PreferenceSectionKey>(
    section: K,
    patch: Partial<Preferences[K]>,
  ) => void;
  /** Adopt values from another tab (storage event) without re-writing. */
  applyExternal: (values: Preferences | null) => void;
  /** Data → "Reset to defaults": writes defaults back to storage. */
  resetToDefaults: () => void;
  /** Data → "Clear saved data": removes the stored entry, back to defaults. */
  clearSaved: () => void;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  subject: "guest",
  values: loadValues("guest"),
  storageOk: storageAvailable(),
  setSubject: (subject) => {
    const current = get();
    if (subject === current.subject) return;
    const storageOk = storageAvailable();
    set({ subject, values: loadValues(subject), storageOk });
  },
  setSection: (sectionKey, patch) => {
    const { subject, values, storageOk } = get();
    const next = withSection(values, sectionKey, patch);
    set({ values: next });
    persist(subject, next, storageOk);
  },
  applyExternal: (values) => {
    set({ values: values ?? migratePreferences({ version: 1 }), storageOk: true });
  },
  resetToDefaults: () => {
    const { subject, storageOk } = get();
    const defaults = migratePreferences({ version: 1 });
    set({ values: defaults });
    persist(subject, defaults, storageOk);
  },
  clearSaved: () => {
    const { subject } = get();
    try {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(PREFS_STORAGE_PREFIX + subject);
      }
    } catch {
      // Unreadable storage — defaults below are still the right answer.
    }
    set({ values: migratePreferences({ version: 1 }) });
  },
}));

/**
 * Cross-tab sync. Exported as a pure handler so tests can drive it without a
 * StorageEvent; the browser listener is registered once at module load.
 * An external event only adopts values for the currently active subject.
 */
export function applyPrefsStorageEvent(key: string | null, newValue: string | null): void {
  if (!key || !key.startsWith(PREFS_STORAGE_PREFIX)) return;
  const subject = key.slice(PREFS_STORAGE_PREFIX.length);
  const state = usePreferencesStore.getState();
  if (subject !== state.subject) return;
  if (newValue === null) {
    state.applyExternal(null);
    return;
  }
  try {
    state.applyExternal(migratePreferences(JSON.parse(newValue) as unknown));
  } catch {
    state.applyExternal(null);
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (event: StorageEvent) => {
    applyPrefsStorageEvent(event.key, event.newValue);
  });
}
