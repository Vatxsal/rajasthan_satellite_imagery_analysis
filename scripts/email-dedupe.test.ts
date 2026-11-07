import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  EMAIL_DEDUPE_WINDOW_MS,
  emailMarkSent,
  emailSendKey,
  emailWasRecentlySent,
  type EmailSendKeyInput,
} from "../lib/email/dedupe";

/** Duplicate-send suppression: the idempotency key must fold exactly the
 *  fields the route derives from a validated request (params normalised the
 *  way resolveCompareParams does + language + content flags + recipient
 *  hash), and the 10-minute window must expire old entries. State lives on
 *  globalThis, so each case starts from an empty log. */

interface EnvHolder {
  "rse.emailSentLog"?: Map<string, number>;
}

beforeEach(() => {
  (globalThis as unknown as EnvHolder)["rse.emailSentLog"]?.clear();
});

function baseInput(overrides: Partial<EmailSendKeyInput> = {}): EmailSendKeyInput {
  return {
    params: {
      areaId: "d-jaisalmer",
      level: "district",
      dateA: "2026-10-10",
      dateB: "2026-10-25",
      sensitivity: "medium",
      minPatchHa: 0.2,
      inputMode: "single",
      compositeWindowDays: 0,
    },
    language: "en",
    includeSummary: true,
    includeImage: true,
    engine: "v1",
    recipientHash: "a".repeat(32),
    ...overrides,
  };
}

function sentLog(): Map<string, number> | undefined {
  return (globalThis as unknown as EnvHolder)["rse.emailSentLog"];
}

test("the key is a stable hex digest that never contains the inputs", () => {
  const key = emailSendKey(baseInput());
  assert.equal(key, emailSendKey(baseInput()));
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.ok(!key.includes("jaisalmer"), "hashed, not raw params");
});

test("every folded field changes the key", () => {
  const key = emailSendKey(baseInput());
  const variants: Array<[string, Partial<EmailSendKeyInput>]> = [
    ["language", { language: "hi" }],
    ["includeSummary", { includeSummary: false }],
    ["includeImage", { includeImage: false }],
    ["recipient", { recipientHash: "b".repeat(32) }],
    ["areaId", { params: { ...baseInput().params, areaId: "d-bikaner" } }],
    ["dates", { params: { ...baseInput().params, dateB: "2026-10-26" } }],
    ["sensitivity", { params: { ...baseInput().params, sensitivity: "high" } }],
    ["minPatchHa", { params: { ...baseInput().params, minPatchHa: 0.5 } }],
    ["level", { params: { ...baseInput().params, level: "tehsil" } }],
  ];
  for (const [label, overrides] of variants) {
    assert.notEqual(emailSendKey(baseInput(overrides)), key, label);
  }
});

test("date order is normalised A-first", () => {
  const forward = emailSendKey(baseInput());
  const swapped = emailSendKey(
    baseInput({
      params: { ...baseInput().params, dateA: "2026-10-25", dateB: "2026-10-10" },
    }),
  );
  assert.equal(forward, swapped, "the same pair dedupes regardless of order");
});

test("engine v1 folds input mode away; engine v2 keeps it", () => {
  const single = baseInput();
  const composite = baseInput({
    params: { ...baseInput().params, inputMode: "composite", compositeWindowDays: 7 },
  });
  // v1 forces single-date inputs (resolveCompareParams), so both payloads
  // describe the same report.
  assert.equal(emailSendKey(single), emailSendKey(composite));

  const v2Single = emailSendKey(baseInput({ engine: "v2" }));
  const v2Composite = emailSendKey(
    baseInput({
      engine: "v2",
      params: { ...baseInput().params, inputMode: "composite", compositeWindowDays: 7 },
    }),
  );
  assert.notEqual(v2Single, v2Composite, "v2 reports differ by input mode");
});

test("a recorded send suppresses only inside the 10-minute window", () => {
  const key = emailSendKey(baseInput());
  const t0 = Date.now();
  emailMarkSent(key, t0);

  assert.equal(emailWasRecentlySent(key, t0), true);
  assert.equal(emailWasRecentlySent(key, t0 + EMAIL_DEDUPE_WINDOW_MS - 1), true);
  assert.equal(emailWasRecentlySent(key, t0 + EMAIL_DEDUPE_WINDOW_MS), false, "window expired");

  // The expired entry was pruned — a fresh mark behaves like a first send.
  assert.equal(sentLog()?.size ?? 0, 0, "expired entries are pruned on read");
  emailMarkSent(key, t0 + EMAIL_DEDUPE_WINDOW_MS + 1);
  assert.equal(emailWasRecentlySent(key, t0 + EMAIL_DEDUPE_WINDOW_MS + 1), true);
});

test("suppression is scoped per key", () => {
  const key = emailSendKey(baseInput());
  const other = emailSendKey(baseInput({ language: "hi" }));
  emailMarkSent(key);
  assert.equal(emailWasRecentlySent(key), true);
  assert.equal(emailWasRecentlySent(other), false, "a different report is unaffected");
});
