/**
 * README capability-table generator — the SINGLE SOURCE is lib/auth/permissions.ts.
 *
 *   npm run docs:permissions
 *
 * Rewrites the block between the markers in README.md:
 *   <!-- BEGIN:capabilities -->
 *   ...generated table...
 *   <!-- END:capabilities -->
 *
 * Exits non-zero if the markers are missing so a hand-edited README cannot
 * silently drift from the policy file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  PERMISSIONS,
  type Capability,
  type Role,
} from "../lib/auth/permissions";

// Compiled into .test-build/scripts/ — two levels up is the repo root
// (same convention as scripts/alias-hook.ts SOURCE_ROOT).
const ROOT = join(__dirname, "..", "..");
const README = join(ROOT, "README.md");
const BEGIN = "<!-- BEGIN:capabilities -->";
const END = "<!-- END:capabilities -->";

const ROLES: Role[] = ["guest", "sso"];

function mark(value: boolean): string {
  return value ? "✅" : "🔒";
}

function limitSummary(role: Role): string {
  const { limits } = PERMISSIONS[role];
  const window = limits.searchWindowDays === null ? "full archive" : `${limits.searchWindowDays}-day window`;
  return (
    `${window} · tiles z≤${limits.tileZoomMax} · ` +
    `${limits.searchesPerDay}/day searches · ${limits.comparePerDay}/day analyses · ` +
    `${limits.aiSummariesPerDay}/day AI · PNG ≤${limits.downloadMaxPx} px`
  );
}

function buildTable(): string {
  const header = [
    "| Capability | Guest | SSO |",
    "| --- | :-: | :-: |",
  ];
  const rows = CAPABILITIES.map((capability: Capability) => {
    const label = CAPABILITY_LABELS[capability];
    const guest = mark(PERMISSIONS.guest.capabilities[capability]);
    const sso = mark(PERMISSIONS.sso.capabilities[capability]);
    return `| ${label} | ${guest} | ${sso} |`;
  });
  const footnotes = [
    "",
    `**Guest limits:** ${limitSummary("guest")}.`,
    "",
    `**SSO limits:** ${limitSummary("sso")}.`,
    "",
    "🔒 = not available for that role (the API answers `403 FORBIDDEN_ROLE`; the UI shows a lock popover).",
    "Daily quotas are counted per session **and** per client IP for each UTC day.",
    "Generated from `lib/auth/permissions.ts` — run `npm run docs:permissions` after editing that file.",
  ];
  return [...header, ...rows, ...footnotes].join("\n");
}

function main(): void {
  const readme = readFileSync(README, "utf8");
  const beginAt = readme.indexOf(BEGIN);
  const endAt = readme.indexOf(END);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    console.error(`README.md is missing the ${BEGIN} / ${END} markers.`);
    process.exit(1);
  }
  const next =
    readme.slice(0, beginAt + BEGIN.length) +
    "\n" +
    buildTable() +
    "\n" +
    readme.slice(endAt);
  if (next === readme) {
    console.log("README capability table is already up to date.");
    return;
  }
  writeFileSync(README, next, "utf8");
  console.log("README capability table regenerated from lib/auth/permissions.ts.");
}

main();
