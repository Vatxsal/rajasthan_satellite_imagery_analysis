import "./alias-hook"; // must be first: installs the "@/…" resolver before the store graph loads

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { WORDMARK_LABEL, WORDMARK_TEXT } from "../lib/brand";
import { beginInFlight, abortInFlight, inFlightSignal } from "../lib/inFlight";
import { registerHomeResetHook, runHomeResetHooks } from "../lib/homeReset";
import { rangeToDates } from "../lib/prefs/range";
import {
  PREFS_STORAGE_PREFIX,
  PreferencesSchema,
  applyPrefsStorageEvent,
  migratePreferences,
  usePreferencesStore,
} from "../store/usePreferencesStore";
import { useAppStore, type DownloadDialogState } from "../store/useAppStore";
import { useCompareStore, type CompareResult } from "../store/useCompareStore";
import { useFieldsStore } from "../store/useFieldsStore";
import { useSession } from "../store/useSession";
import type { Scene } from "../lib/data";

/**
 * Home link + home reset (Part 1): wordmark contract, abort registry,
 * resetToHome behaviour across the app/compare/fields stores (what it clears,
 * what it keeps), preference-backed filter defaults, and source contracts for
 * the abort wiring that cannot be exercised without a network.
 */

const read = (...parts: string[]): string =>
  readFileSync(join(__dirname, "..", "..", ...parts), "utf8");

test("wordmark is a home link with a passing accessible name", () => {
  const topbar = read("components", "shell", "TopBar.tsx");
  const brand = read("lib", "brand.ts");

  assert.match(brand, /WORDMARK_TEXT\s*=\s*"Rajasthan Imagery Explorer"/);
  assert.match(brand, /WORDMARK_LABEL\s*=\s*"Rajasthan Imagery Explorer, home"/);
  // Lighthouse label-content-name-mismatch: visible text ⊆ accessible name.
  assert.ok(WORDMARK_LABEL.includes(WORDMARK_TEXT));

  assert.match(topbar, /href="\//); // Wordmark navigates to home
  assert.match(topbar, /aria-label=\{WORDMARK_LABEL\}/);
  assert.match(topbar, /resetToHome\(\{\s*replaceUrl:/);
  assert.match(topbar, /router\.replace\(url\)/); // SPA replace — no reload/logout
  // Native behaviour kept for modified/middle clicks (new tab, window, …).
  assert.match(topbar, /event\.button !== 0/);
  assert.match(topbar, /event\.metaKey/);
  assert.match(topbar, /event\.ctrlKey/);
  // The old short title is gone — one name everywhere so accname matches.
  assert.doesNotMatch(topbar, /Rajasthan Explorer/);
});

test("login page keeps its own branding and never resets home", () => {
  const login = read("components", "login", "AccessPanel.tsx");
  assert.ok(login.includes("Rajasthan Imagery Explorer"));
  assert.doesNotMatch(login, /resetToHome/);
  assert.doesNotMatch(login, /lib\/brand/);
});

test("in-flight registry: supersede, abort, drop", () => {
  const first = beginInFlight("t-basic");
  assert.equal(inFlightSignal("t-basic"), first.signal);
  assert.equal(first.signal.aborted, false);

  const second = beginInFlight("t-basic");
  assert.ok(first.signal.aborted, "a newer request aborts the previous one");
  assert.equal(second.signal.aborted, false);

  abortInFlight("t-basic");
  assert.ok(second.signal.aborted);
  assert.equal(inFlightSignal("t-basic"), null);
  abortInFlight("t-basic"); // idempotent no-op
});

test("home reset hooks run in order and isolate failures", () => {
  const calls: string[] = [];
  const unregisterFirst = registerHomeResetHook(() => calls.push("first"));
  registerHomeResetHook(() => {
    throw new Error("one broken store must not block the rest");
  });
  const unregisterThird = registerHomeResetHook(() => calls.push("third"));

  runHomeResetHooks();
  assert.deepEqual(calls, ["first", "third"], "broken hook skipped, order kept");

  unregisterFirst();
  unregisterThird();
  runHomeResetHooks();
  assert.deepEqual(calls, ["first", "third"], "unregistered hooks no longer run");
});

test("migratePreferences: defaults, safe sections, unknown versions", () => {
  const defaults = migratePreferences({ version: 1 });
  assert.equal(defaults.map.maxCloudCover, 20);
  assert.equal(defaults.appearance.textSize, "100");
  assert.equal(defaults.map.dateRange, "90d");

  // Missing/corrupt payloads collapse to defaults.
  assert.equal(migratePreferences(undefined).version, 1);
  assert.equal(migratePreferences("not-json").map.composite, "true-color");
  assert.equal(migratePreferences({ version: 99, map: { maxCloudCover: 5 } }).map.maxCloudCover, 20);

  // Partial v1: valid section kept, invalid section refilled.
  const partial = migratePreferences({
    version: 1,
    map: { maxCloudCover: 55 },
    units: { areaUnit: "bogus" },
  });
  assert.equal(partial.map.maxCloudCover, 55);
  assert.equal(partial.units.areaUnit, "ha");

  // The stored shape is the complete schema — preference keys only, no secrets.
  const stored = PreferencesSchema.parse({ version: 1 });
  assert.deepEqual(Object.keys(stored).sort(), [
    "appearance",
    "change",
    "map",
    "reports",
    "units",
    "version",
  ]);
  const text = JSON.stringify(stored).toLowerCase();
  assert.doesNotMatch(text, /password|token|secret|hash/);
});

test("cross-tab prefs event adopts only the active subject", () => {
  usePreferencesStore.getState().setSubject("guest");
  const keyFor = (subject: string) => `${PREFS_STORAGE_PREFIX}${subject}`;

  applyPrefsStorageEvent(keyFor("someone-else"), JSON.stringify({ version: 1, map: { maxCloudCover: 77 } }));
  assert.equal(usePreferencesStore.getState().values.map.maxCloudCover, 20, "other subject ignored");

  applyPrefsStorageEvent(keyFor("guest"), JSON.stringify({ version: 1, map: { maxCloudCover: 77 } }));
  assert.equal(usePreferencesStore.getState().values.map.maxCloudCover, 77);

  applyPrefsStorageEvent(keyFor("guest"), "{corrupt json");
  assert.equal(usePreferencesStore.getState().values.map.maxCloudCover, 20, "corrupt → defaults");

  applyPrefsStorageEvent(keyFor("guest"), null);
  assert.equal(usePreferencesStore.getState().values.map.maxCloudCover, 20, "cleared → defaults");

  applyPrefsStorageEvent("rie:unrelated:key", "x"); // foreign key ignored
  assert.equal(usePreferencesStore.getState().values.map.maxCloudCover, 20);
});

test("resetToHome clears selection/results/compare/fields, keeps session and basemap", () => {
  // This account's saved preferences drive the reapplied filter/map defaults.
  useSession.getState().setSession({ role: "sso", name: "Admin User", username: "admin" });
  usePreferencesStore.getState().setSubject("admin");
  usePreferencesStore.getState().setSection("map", {
    dateRange: "30d",
    maxCloudCover: 45,
    composite: "ndvi",
    overlayOpacity: 0.5,
    boostVisibility: false,
  });

  useAppStore.getState().setBasemap("satellite");

  const fakePolygon: GeoJSON.Polygon = {
    type: "Polygon",
    coordinates: [[[74, 26], [75, 26], [75, 27], [74, 26]]],
  };
  const fakeScene = { id: "s1", title: "Sentinel-2 · 2026-01-01" } as unknown as Scene;
  const fakeResult = { key: "analysis-1" } as unknown as CompareResult;
  const fakeDialog = {
    scene: fakeScene,
    target: "png",
    format: "png",
    plan: { reduced: false },
  } as unknown as DownloadDialogState;

  useAppStore.setState({
    districtId: "d1",
    districtSel: { level: "district", id: "d1", name: "Ajmer", geometry: fakePolygon, bbox: [74, 26, 75, 27] },
    scenes: [fakeScene],
    activeSceneId: "s1",
    hoveredSceneId: "s1",
    hasSearched: true,
    searchError: "boom",
    searching: true,
    calendarMonth: { year: 2026, month: 0 },
    resultsOpen: true,
    sidebarTab: "status",
    sidebarOpen: false,
    sidebarCollapsed: true,
    downloadDialog: fakeDialog,
    imageryVisible: true,
  });
  useCompareStore.setState({
    compareMode: true,
    dateA: "2026-01-01",
    dateB: "2026-02-01",
    running: true,
    stage: "analyze",
    error: { code: "BOOM", message: "boom" },
    result: fakeResult,
    drawerOpen: true,
    stripExpanded: true,
    eventsTotal: 10,
  });
  useFieldsStore.setState({
    count: 9,
    selectedFieldId: "f-9",
    patternRunning: true,
    loading: true,
    year: 2025,
    visible: false,
  });

  // In-flight requests must be aborted by the reset.
  const searchFlight = beginInFlight("search");
  const summaryFlight = beginInFlight("summary");
  const emailFlight = beginInFlight("email");

  const replaced: string[] = [];
  const homeBefore = useAppStore.getState().homeNonce;
  const snapBefore = useAppStore.getState().panelSnapReset;
  useAppStore.getState().resetToHome({ replaceUrl: (url) => replaced.push(url) });

  const app = useAppStore.getState();
  const compare = useCompareStore.getState();
  const fields = useFieldsStore.getState();

  // Requests aborted.
  assert.ok(searchFlight.signal.aborted);
  assert.ok(summaryFlight.signal.aborted);
  assert.ok(emailFlight.signal.aborted);

  // URL stripped (SPA replace, no reload).
  assert.deepEqual(replaced, ["/"]);

  // App store: selection + results cleared, filter defaults reapplied.
  assert.equal(app.districtId, null);
  assert.equal(app.districtSel, null);
  assert.deepEqual(app.scenes, []);
  assert.equal(app.activeSceneId, null);
  assert.equal(app.hoveredSceneId, null);
  assert.equal(app.hasSearched, false);
  assert.equal(app.searchError, null);
  assert.equal(app.searching, false);
  assert.equal(app.calendarMonth, null);
  assert.equal(app.resultsOpen, false);
  assert.equal(app.downloadDialog, null);
  assert.equal(app.sidebarTab, "filters");
  assert.equal(app.sidebarOpen, true);
  assert.equal(app.sidebarCollapsed, false);
  const range30 = rangeToDates("30d");
  assert.equal(app.fromDate, range30.from);
  assert.equal(app.toDate, range30.to);
  assert.equal(app.maxCloudCover, 45);
  assert.equal(app.composite, "ndvi");

  // Map home + phone sheet collapse are signalled.
  assert.equal(app.homeNonce, homeBefore + 1);
  assert.equal(app.panelSnapReset, snapBefore + 1);

  // Kept: user's basemap/session choices and the imagery layer toggle.
  assert.equal(app.basemap, "satellite");
  assert.equal(app.imageryVisible, true);
  assert.equal(useSession.getState().role, "sso");
  assert.equal(useSession.getState().name, "Admin User");
  assert.equal(usePreferencesStore.getState().subject, "admin");

  // Compare store: back to idle, overlay/visibility prefs reapplied.
  assert.equal(compare.compareMode, false);
  assert.equal(compare.dateA, null);
  assert.equal(compare.dateB, null);
  assert.equal(compare.running, false);
  assert.equal(compare.stage, null);
  assert.equal(compare.error, null);
  assert.equal(compare.result, null);
  assert.equal(compare.drawerOpen, false);
  assert.equal(compare.stripExpanded, false);
  assert.equal(compare.eventsTotal, 0);
  assert.equal(compare.overlayOpacity, 0.5);
  assert.equal(compare.boostVisibility, false);

  // Fields store: data/pattern dropped, view settings kept.
  assert.equal(fields.count, 0);
  assert.equal(fields.fields, null);
  assert.equal(fields.selectedFieldId, null);
  assert.equal(fields.patternRunning, false);
  assert.equal(fields.loading, false);
  assert.equal(fields.year, 2025, "view settings are kept");
  assert.equal(fields.visible, false);

  // Idempotent: running it again keeps the same clean state.
  useAppStore.getState().resetToHome({ replaceUrl: (url) => replaced.push(url) });
  assert.deepEqual(replaced, ["/", "/"]);
  assert.equal(useAppStore.getState().panelSnapReset, snapBefore + 2);
  assert.deepEqual(useAppStore.getState().scenes, []);

  // No replaceUrl → history fallback is guarded (no window in node: no-op).
  useAppStore.getState().resetToHome();
});

test("an in-flight search is discarded when home reset aborts it", async () => {
  useAppStore.setState({ districtId: "d1" });
  const pending = useAppStore.getState().runSearch();
  useAppStore.getState().resetToHome();
  await pending;

  const after = useAppStore.getState();
  assert.equal(after.searching, false);
  assert.equal(after.searchError, null);
  assert.deepEqual(after.scenes, []);
  assert.equal(after.hasSearched, false);
  assert.equal(after.districtId, null);
});

test("abort + reset + preferences wiring (source contracts)", () => {
  const appStore = read("store", "useAppStore.ts");
  assert.match(appStore, /beginInFlight\(IN_FLIGHT\.search\)/, "runSearch abortable");
  assert.match(appStore, /signal: controller\.signal/);
  assert.match(appStore, /rangeToDates\(initialPrefs\.map\.dateRange\)/, "filters seeded from prefs");
  assert.match(appStore, /maxCloudCover: initialPrefs\.map\.maxCloudCover/);
  assert.match(appStore, /filtersTouched/);
  assert.match(appStore, /basemapTouched/);
  assert.match(appStore, /resetToHome: \(opts\) => \{/);
  assert.doesNotMatch(appStore, /useTheme/, "reset never touches the theme store");

  const cdse = read("lib", "data", "cdseAdapter.ts");
  assert.match(cdse, /signal\?: AbortSignal/);
  assert.match(cdse, /opts\?\.signal/);
  const mock = read("lib", "data", "mockAdapter.ts");
  assert.match(mock, /AbortError/, "mock adapter rejects aborted searches");

  const compare = read("store", "useCompareStore.ts");
  assert.match(compare, /beginInFlight\(IN_FLIGHT\.summary\)/, "AI summary abortable");
  assert.match(compare, /registerHomeResetHook/, "compare participates in home reset");

  const fields = read("store", "useFieldsStore.ts");
  assert.match(fields, /registerHomeResetHook/, "fields participate in home reset");
  assert.match(fields, /fieldsEpoch/, "late field/pattern responses discarded");

  const email = read("components", "compare", "EmailReport.tsx");
  assert.match(email, /beginInFlight\(IN_FLIGHT\.email\)/, "report email abortable");

  const session = read("store", "useSession.ts");
  assert.match(session, /syncPreferencesSubject/);
  assert.match(session, /seedFromPreferences/);

  const filters = read("components", "filters", "FiltersPanel.tsx");
  assert.match(filters, /DATE_RANGE_DAYS/, "date presets share lib/prefs/range with resetToHome");

  const bottomSheet = read("components", "ui", "BottomSheet.tsx");
  assert.match(bottomSheet, /collapsedSnapNonce/);
  const panel = read("components", "shell", "Panel.tsx");
  assert.match(panel, /collapsedSnapNonce=\{panelSnapReset\}/, "phone sheet collapses on home");
});
