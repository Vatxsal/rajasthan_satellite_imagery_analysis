import "./alias-hook"; // must be first: installs the "@/…" resolver before the module graph loads

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { polygon } from "@turf/turf";
import {
  SAVED_SHAPES_MAX,
  listSavedShapes,
  removeSavedShape,
  savedShapeId,
  upsertSavedShape,
} from "../lib/draw/saved";

/** Unit contract for the browser-local saved-shape store (Phase 4): the
 *  memory fallback (node has no window), content-hash ids that survive
 *  re-seeding, insert-or-update semantics, the 50-item cap, per-subject
 *  isolation, and the corrupt/quota storage paths. */

function square(offset = 0): GeoJSON.Polygon {
  const x = 75 + offset;
  const y = 26 + offset;
  return polygon([
    [
      [x, y],
      [x + 0.02, y],
      [x + 0.02, y + 0.02],
      [x, y + 0.02],
      [x, y],
    ],
  ]).geometry;
}

function record(offset = 0, name = "Field") {
  return { name, note: "", color: "#ff6600", geometry: square(offset) };
}

let windowBackup: unknown;

beforeEach(() => {
  windowBackup = (globalThis as { window?: unknown }).window;
});

afterEach(() => {
  const holder = globalThis as { window?: unknown };
  if (windowBackup === undefined) delete holder.window;
  else holder.window = windowBackup;
});

function setWindow(value: unknown): void {
  (globalThis as { window?: unknown }).window = value;
}

test("saved: falls back to memory without a window", () => {
  const result = upsertSavedShape("mem", record());
  assert.equal(result.outcome, "saved");
  assert.equal(result.shapes.length, 1);

  const listed = listSavedShapes("mem");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.name, "Field");
  assert.match(listed[0]!.id, /^ls:[0-9a-f]{16}$/);
  assert.ok(Number.isFinite(Date.parse(listed[0]!.savedAt)));
});

test("saved: id is stable across closing/duplicate seed points", () => {
  const base = square();

  const closedTwice = square();
  closedTwice.coordinates[0]!.push([...closedTwice.coordinates[0][0]!]);

  const seeded = square();
  seeded.coordinates[0]!.splice(1, 0, [...seeded.coordinates[0][0]!]);

  const ids = [savedShapeId(base), savedShapeId(closedTwice), savedShapeId(seeded)];
  assert.equal(ids[0], ids[1], "closing point does not change the hash");
  assert.equal(ids[0], ids[2], "consecutive duplicates do not change the hash");
  assert.notEqual(savedShapeId(square(0.001)), ids[0], "different content, different id");
});

test("saved: re-saving the same shape updates it in place", () => {
  const first = upsertSavedShape("update", record(0, "Old"));
  assert.equal(first.outcome, "saved");

  const second = upsertSavedShape("update", record(0, "Renamed"));
  assert.equal(second.outcome, "saved");
  assert.equal(second.shapes.length, 1, "one slot per content id");
  assert.equal(second.shapes[0]!.name, "Renamed");
  assert.equal(listSavedShapes("update").length, 1);
});

test("saved: subjects are isolated (guest vs SSO)", () => {
  upsertSavedShape("guest", record(0, "Guest shape"));
  upsertSavedShape("alice", record(0, "Alice shape"));

  assert.equal(listSavedShapes("guest")[0]!.name, "Guest shape");
  assert.equal(listSavedShapes("alice")[0]!.name, "Alice shape");
  assert.equal(listSavedShapes("bob").length, 0);

  removeSavedShape("guest", listSavedShapes("guest")[0]!.id);
  assert.equal(listSavedShapes("guest").length, 0);
  assert.equal(listSavedShapes("alice").length, 1, "removal never crosses subjects");
});

test("saved: the cap answers full and leaves the list untouched", () => {
  const subject = "cap";
  for (let i = 0; i < SAVED_SHAPES_MAX; i++) {
    const result = upsertSavedShape(subject, record(i * 0.01, `Shape ${i}`));
    assert.equal(result.outcome, "saved", `fill ${i}`);
  }
  assert.equal(listSavedShapes(subject).length, SAVED_SHAPES_MAX);

  const overflow = upsertSavedShape(subject, record(99, "One too many"));
  assert.equal(overflow.outcome, "full");
  assert.equal(overflow.shapes.length, SAVED_SHAPES_MAX);

  // Updating an existing slot still works at the cap.
  const refresh = upsertSavedShape(subject, record(0, "Shape 0 renamed"));
  assert.equal(refresh.outcome, "saved");
  assert.equal(refresh.shapes.length, SAVED_SHAPES_MAX);
  assert.ok(
    listSavedShapes(subject).some((item) => item.name === "Shape 0 renamed"),
    "the refreshed record is in the stored list",
  );
});

test("saved: invalid records are rejected without touching the list", () => {
  const badColor = upsertSavedShape("bad", {
    name: "x".repeat(81),
    note: "",
    color: "orange",
    geometry: square(),
  });
  assert.equal(badColor.outcome, "invalid");
  assert.equal(badColor.shapes.length, 0);
  assert.equal(listSavedShapes("bad").length, 0);
});

test("saved: corrupt storage reads as an empty list", () => {
  setWindow({
    localStorage: {
      getItem: () => "{not json",
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });

  assert.deepEqual(listSavedShapes("corrupt"), []);
  const result = upsertSavedShape("corrupt", record());
  assert.equal(result.outcome, "saved", "the write itself does not throw");
  assert.equal(result.shapes.length, 1);
});

test("saved: a throwing localStorage (quota) falls back to memory", () => {
  setWindow({
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => undefined,
    },
  });

  const result = upsertSavedShape("quota", record(0, "Kept in memory"));
  assert.equal(result.outcome, "saved");
  assert.equal(listSavedShapes("quota")[0]!.name, "Kept in memory");
});
