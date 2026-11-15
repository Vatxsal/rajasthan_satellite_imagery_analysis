import "./alias-hook"; // must be first: installs the "@/…" resolver before the store graph loads

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { formatArea, formatDate, formatCoords, formatDateTime } from "../lib/format";
import { PreferencesSchema, migratePreferences, usePreferencesStore } from "../store/usePreferencesStore";
import { useCompareStore } from "../store/useCompareStore";

/**
 * Preferences (Part 3): formatter units/format/time-zone behaviour, the
 * Preferences dialog contract (six sections, instant apply, no Save, SSO
 * gating, reset/clear), the appearance wiring (root font size + reduced
 * motion), the compare-store seeding from saved preferences, and every format
 * call site surveyed for the unit/time/date switch-over.
 */

const read = (...parts: string[]): string =>
  readFileSync(join(__dirname, "..", "..", ...parts), "utf8");

// ---------------------------------------------------------------- formatters

test("formatArea: hectares stay canonical-precise in every unit", () => {
  assert.equal(formatArea(1234.56, "ha"), "1,234.6 ha");
  assert.equal(formatArea(1234.56, "ha", { maximumFractionDigits: 0 }), "1,235 ha");
  assert.equal(formatArea(1234.56, "km2"), "12.35 km²");
  assert.equal(formatArea(100, "acre"), "247.1 ac");
  assert.equal(formatArea(100, "acre", { maximumFractionDigits: 0 }), "247 ac");
  // Same numbers the old call sites printed (ha path is the legacy string).
  assert.equal(formatArea(0.2), "0.2 ha");
  assert.equal(formatArea(12), "12 ha"); // md1 drops the trailing zero
  assert.equal(formatArea(Number.NaN, "ha"), "—");
});

test("formatCoords: DD matches the old readout, DMS carries hemispheres", () => {
  assert.equal(formatCoords(75.1234567, 17.1234567, "dd"), "17.1235° N  75.1235° E");
  const dms = formatCoords(75.1234567, 17.1234567, "dms");
  assert.match(dms, /^17° 7' 24\.\d" N {2}75° 7' 24\.\d" E$/);
  assert.equal(formatCoords(-1.5, -2.25, "dd"), "2.2500° S  1.5000° W");
  assert.match(formatCoords(-1.5, -2.25, "dms"), /S/);
  assert.match(formatCoords(-1.5, -2.25, "dms"), /W/);
});

test("formatDate: the default keeps today's card rendering", () => {
  assert.equal(formatDate("2026-01-05"), "05 Jan 2026");
  assert.equal(formatDate("2026-01-05", "dd-mon-yyyy"), "05 Jan 2026");
  assert.equal(formatDate("2026-01-05", "dd-mm-yyyy"), "05-01-2026");
  assert.equal(formatDate("2026-01-05", "yyyy-mm-dd"), "2026-01-05");
  assert.equal(formatDate("not-a-date"), "not-a-date", "garbage in, garbage out");
});

test("formatDate default unit prefs: zone + schema defaults", () => {
  // Time zone formatting (Part 2) still resolves through the shared table.
  assert.match(formatDateTime(0, { timeZone: "ist", dateOnly: true }), /^\d{2} [A-Z][a-z]{2} 1970$/);
  assert.match(formatDateTime(0, { timeZone: "utc", dateOnly: true }), /^01 Jan 1970$/);
  // The schema default must keep the legacy "05 Jan 2026" scene rendering.
  const prefs = PreferencesSchema.parse({ version: 1 });
  assert.equal(prefs.units.dateFormat, "dd-mon-yyyy");
  assert.equal(prefs.units.areaUnit, "ha");
  assert.equal(prefs.units.coordinates, "dd");
  assert.equal(prefs.units.timeZone, "ist");
});

// ------------------------------------------------------------- dialog contract

test("preferences dialog: six sections, instant apply, no save button", () => {
  const dialog = read("components", "shell", "PreferencesDialog.tsx");
  // The six rendered sections.
  for (const title of [
    "Appearance",
    "Map defaults",
    "Units and format",
    "Change detection",
    "Reports",
    "Data",
  ]) {
    assert.ok(dialog.includes(`title="${title}"`), `section ${title}`);
  }
  // Instant apply through setSection — there is deliberately no Save button.
  assert.match(dialog, /setSection\("appearance"/);
  assert.match(dialog, /setSection\("map"/);
  assert.match(dialog, /setSection\("units"/);
  assert.match(dialog, /setSection\("change"/);
  assert.match(dialog, /setSection\("reports"/);
  assert.doesNotMatch(dialog, /Save (preferences|changes)/i);
  assert.doesNotMatch(dialog, /type="submit"/);
  // Appearance controls (theme lives in the existing useTheme store).
  assert.match(dialog, /useTheme\(\(s\) => s\.theme\)/);
  assert.match(dialog, /textSize/);
  assert.match(dialog, /reduceAnimations/);
  // Map defaults carry the apply-timing helper text.
  assert.match(dialog, /Applied when the app starts or after Home/);
  // Data section: reset (immediate), clear (inline two-step confirm), notices.
  assert.match(dialog, /Reset to defaults/);
  assert.match(dialog, /Clear saved data/);
  assert.match(dialog, /Yes, clear everything/);
  assert.match(dialog, /Clear all saved preferences for this account\?/);
  assert.match(dialog, /resetToDefaults/);
  assert.match(dialog, /clearSaved/);
  assert.match(dialog, /storageOk/);
  assert.match(dialog, /Browser storage is unavailable/);
  // Canonical-units disclaimer.
  assert.match(dialog, /canonical units \(hectares\) and UTC/);
  // Read-only masked fixed-recipient hint (never the raw address).
  assert.match(dialog, /recipientHint/);
  assert.match(dialog, /Reports are delivered to/);
  assert.doesNotMatch(dialog, /EMAIL_FIXED_RECIPIENT/);
});

test("preferences dialog: change and reports sections are SSO-gated", () => {
  const dialog = read("components", "shell", "PreferencesDialog.tsx");
  assert.match(dialog, /useLocked\("compare\.adjust-sensitivity"\)/);
  assert.match(dialog, /useLocked\("email\.report"\)/);
  assert.match(dialog, /Available with an SSO ID/);
  assert.match(dialog, /<fieldset disabled=\{lockedChange\}/);
  assert.match(dialog, /<fieldset disabled=\{lockedReports\}/);
  // Guests can still see the locked sections in place.
  assert.match(dialog, /\{lockedChange && <LockedNote/);
  assert.match(dialog, /\{lockedReports && <LockedNote/);
});

test("preferences dialog: opens from the account menu", () => {
  const topbar = read("components", "shell", "TopBar.tsx");
  assert.match(topbar, /onSelect=\{\(\) => setPrefsOpen\(true\)\}>Preferences</);
  assert.match(topbar, /<PreferencesDialog open=\{prefsOpen\} onOpenChange=\{setPrefsOpen\} \/>/);
  assert.doesNotMatch(topbar, /<MenuItem>Preferences<\/MenuItem>/, "the menu item is wired");
});

test("profile and preferences: hash deep links open on load and clear on close", () => {
  const topbar = read("components", "shell", "TopBar.tsx");
  // On load, /#preferences or /#profile opens the matching dialog…
  assert.match(topbar, /hash === "#preferences"\) setPrefsOpen\(true\)/);
  assert.match(topbar, /hash === "#profile"\) setProfileOpen\(true\)/);
  // …and toggling keeps the fragment in step via replaceState (no history spam),
  // clearing only our own fragment when a dialog closes.
  assert.match(topbar, /setDialogFragment\(profileOpen \? "#profile" : null, "#profile"\)/);
  assert.match(topbar, /setDialogFragment\(prefsOpen \? "#preferences" : null, "#preferences"\)/);
  assert.match(topbar, /history\.replaceState/);
  assert.match(topbar, /if \(url\.hash !== own\) return;/);
});

// --------------------------------------------------------- appearance wiring

test("appearance sync: root font size + reduce-animation attribute", () => {
  const themeSync = read("components", "shell", "ThemeSync.tsx");
  assert.match(themeSync, /root\.style\.fontSize/);
  assert.match(themeSync, /textSize === "100" \? ""/);
  assert.match(themeSync, /dataset\.reduceAnimations = reduceAnimations/);
  const globals = read("app", "globals.css");
  assert.match(globals, /\[data-reduce-animations="on"\]/);
  assert.match(globals, /prefers-reduced-motion: reduce/);
  assert.match(
    globals,
    /:root:not\(\[data-reduce-animations="off"\]\)/,
    '"off" must beat the OS preference',
  );
  const layout = read("app", "layout.tsx");
  assert.match(layout, /ThemeSync/, "the sync component stays mounted in the root layout");
});

// ------------------------------------------------------------ store behaviour

test("preferences store: instant-apply persists per section (memory fallback)", () => {
  const state = usePreferencesStore.getState();
  assert.equal(state.storageOk, false, "node has no window — memory-only fallback");
  state.setSection("units", { areaUnit: "km2", timeZone: "utc" });
  const next = usePreferencesStore.getState().values;
  assert.equal(next.units.areaUnit, "km2");
  assert.equal(next.units.timeZone, "utc");
  assert.equal(next.units.dateFormat, "dd-mon-yyyy", "other fields untouched");
  usePreferencesStore.getState().resetToDefaults();
  assert.equal(usePreferencesStore.getState().values.units.areaUnit, "ha");
  // Corrupt storage payloads collapse to defaults, section by section.
  const migrated = migratePreferences({ version: 99, units: { areaUnit: "acre" } });
  assert.equal(migrated.version, 1);
  assert.equal(migrated.units.areaUnit, "ha", "unknown version starts clean");
});

test("compare store: sensitivity, summary and overlay seed from preferences", () => {
  const compare = read("store", "useCompareStore.ts");
  assert.match(compare, /const initialPrefs = usePreferencesStore\.getState\(\)\.values/);
  assert.match(compare, /sensitivity: initialPrefs\.change\.sensitivity/);
  assert.match(compare, /minPatchHa: initialPrefs\.change\.minPatchHa/);
  assert.match(compare, /summaryLanguage: initialPrefs\.reports\.language/);
  assert.match(compare, /summaryIncludeImages: initialPrefs\.reports\.includeImage/);
  assert.match(compare, /overlayOpacity: initialPrefs\.map\.overlayOpacity/);
  assert.match(compare, /boostVisibility: initialPrefs\.map\.boostVisibility/);
  // Live state still matches the schema defaults on a fresh profile.
  const state = useCompareStore.getState();
  assert.equal(state.sensitivity, "medium");
  assert.equal(state.minPatchHa, 0.2);
  assert.equal(state.summaryLanguage, "en");
  assert.equal(state.summaryIncludeImages, true);
});

// ------------------------------------------------------------- format call sites

test("format call sites: every surveyed surface uses the shared formatters", () => {
  const stats = read("components", "compare", "CompareStatsTab.tsx");
  assert.match(stats, /haRound\(stats\.areaHa, areaUnit\)/);
  assert.match(stats, /ha\(stats\.changedHa, areaUnit\)/);
  assert.match(stats, /formatArea\(areaHa, areaUnit\)/);
  assert.match(stats, /formatDateTime\(Math\.floor\(Date\.parse\(metadata\.generatedAt\)/);
  assert.doesNotMatch(stats, /toLocaleString\("en", \{ maximumFractionDigits: 1 \}\) ha/);

  const drawer = read("components", "compare", "CompareDrawer.tsx");
  assert.match(drawer, /formatArea\(cls\.areaHa, areaUnit/);
  assert.doesNotMatch(drawer, /areaHa\.toLocaleString/);

  const fields = read("components", "fields", "FieldsPanel.tsx");
  assert.match(fields, /formatHa\(totalAreaM2, areaUnit\)/);
  assert.match(fields, /formatArea\(ha, unit, opts\)/);

  const card = read("components", "scenes", "SceneCard.tsx");
  assert.match(card, /formatDate\(scene\.date, dateFormat\)/);
  assert.doesNotMatch(card, /function formatDate\(/, "the local copy is gone");

  const cursor = read("components", "map", "CursorCoords.tsx");
  assert.match(cursor, /formatCoords\(coords\[0\], coords\[1\], coordFormat\)/);
  assert.doesNotMatch(cursor, /toFixed\(4\)}° N/);

  const bridge = read("lib", "compare", "bridge.ts");
  assert.match(bridge, /\$\{formatArea\(areaHa, areaUnit\)\}/);
  assert.match(bridge, /const areaUnit = usePreferencesStore\.getState\(\)\.values\.units\.areaUnit/);
  assert.ok(
    bridge.includes("|${areaUnit}`"),
    "markers rebuild when the unit changes (unit is part of the signature)",
  );
});
