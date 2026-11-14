import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  PERMISSIONS,
} from "../lib/auth/permissions";

/** README capability table must stay in sync with lib/auth/permissions.ts. */

const ROOT = join(__dirname, "..", ".."); // compiled to .test-build/scripts/
const BEGIN = "<!-- BEGIN:capabilities -->";
const END = "<!-- END:capabilities -->";

function readmeBlock(): string {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const beginAt = readme.indexOf(BEGIN);
  const endAt = readme.indexOf(END);
  assert.ok(beginAt !== -1, "README missing BEGIN:capabilities marker");
  assert.ok(endAt !== -1 && endAt > beginAt, "README missing END:capabilities marker");
  return readme.slice(beginAt + BEGIN.length, endAt);
}

test("README capability table lists every capability with both role marks", () => {
  const block = readmeBlock();
  assert.ok(block.length > 0, "capability table block is empty — run npm run docs:permissions");
  for (const capability of CAPABILITIES) {
    const label = CAPABILITY_LABELS[capability];
    assert.ok(block.includes(`| ${label} |`), `missing row for ${capability} (${label})`);
    const guestMark = PERMISSIONS.guest.capabilities[capability] ? "✅" : "🔒";
    const ssoMark = PERMISSIONS.sso.capabilities[capability] ? "✅" : "🔒";
    // Row shape: | Label | guest | sso |
    const row = block.split("\n").find((line) => line.startsWith(`| ${label} |`));
    assert.ok(row, `row not found for ${label}`);
    assert.ok(
      row.includes(`| ${guestMark} | ${ssoMark} |`),
      `row for ${label} does not match policy (expected ${guestMark}/${ssoMark}): ${row}`,
    );
  }
});

test("README capability table documents both role limit summaries", () => {
  const block = readmeBlock();
  assert.match(block, /\*\*Guest limits:\*\*/);
  assert.match(block, /\*\*SSO limits:\*\*/);
  assert.match(block, /npm run docs:permissions/);
});
