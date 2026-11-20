/**
 * Draw & analyze — browser-local saved shapes (Phase 4).
 *
 * Saved shapes persist per subject in localStorage under
 * `rie:shapes:v1:<subject>` (the SSO username or "guest", the same subject
 * preferences use), so guest and SSO saves never mix. Records are
 * zod-validated on read — a corrupt entry drops out instead of crashing the
 * panel — and when localStorage is unavailable (privacy modes, node tests)
 * an in-memory map keeps the session working, mirroring the preferences
 * store's fallback.
 *
 * A record's id is a content hash of its exterior ring (canonical, ~0.1 m
 * precision), so re-saving an unchanged shape updates the same record and
 * the ShapeCard "Saved" state survives page reloads and re-imports.
 */
import { z } from "zod";
import { polygonSchema } from "@/lib/draw/schema";

export const SAVED_SHAPES_PREFIX = "rie:shapes:v1:";
/** Role-agnostic cap (the draw.save capability gates who may save). */
export const SAVED_SHAPES_MAX = 50;

const savedShapeSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(80),
  note: z.string().max(500),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  geometry: polygonSchema,
  savedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "must be a timestamp"),
});

export type SavedShape = z.infer<typeof savedShapeSchema>;

/** In-memory fallback when localStorage is unavailable (session-scoped). */
const memory = new Map<string, SavedShape[]>();

function storageKey(subject: string): string {
  return SAVED_SHAPES_PREFIX + subject;
}

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const probe = `${SAVED_SHAPES_PREFIX}__probe__`;
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Content hash of the exterior ring — consecutive duplicates and the
 * closing point are dropped first, so the same drawn/imported polygon
 * hashes identically however it was seeded or closed.
 */
export function savedShapeId(geometry: GeoJSON.Polygon): string {
  const raw = geometry.coordinates[0] ?? [];
  const points: string[] = [];
  for (const position of raw) {
    const key = `${(position[0] ?? 0).toFixed(6)},${(position[1] ?? 0).toFixed(6)}`;
    if (points[points.length - 1] !== key) points.push(key);
  }
  if (points.length > 1 && points[0] === points[points.length - 1]) points.pop();
  const canonical = points.join(";");

  // Two 32-bit FNV-1a variants → 16 hex chars (plenty for a 50-item list).
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const code = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 + code, 0x85ebca6b) ^ (h1 >>> 13)) >>> 0;
  }
  return `ls:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** Saved shapes for a subject (invalid/corrupt entries are dropped). */
export function listSavedShapes(subject: string): SavedShape[] {
  const key = storageKey(subject);
  const store = getStorage();
  if (!store) return memory.get(key) ?? [];
  try {
    const text = store.getItem(key);
    if (text === null) return [];
    const parsed = z.array(savedShapeSchema).safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export type SaveShapeOutcome = "saved" | "full" | "invalid";

/**
 * Insert-or-update by content id. Unchanged shapes keep their slot; edited
 * geometry hashes to a new id and appends (cap permitting). Removal is an
 * explicit list action — the ShapeCard button never silently unsaves.
 */
export function upsertSavedShape(
  subject: string,
  record: Omit<SavedShape, "id" | "savedAt"> & { id?: string },
): { outcome: SaveShapeOutcome; shapes: SavedShape[] } {
  const id = record.id ?? savedShapeId(record.geometry as GeoJSON.Polygon);
  const existing = listSavedShapes(subject);
  const without = existing.filter((shape) => shape.id !== id);
  if (without.length >= SAVED_SHAPES_MAX) {
    return { outcome: "full", shapes: existing };
  }
  const parsed = savedShapeSchema.safeParse({
    ...record,
    id,
    savedAt: new Date().toISOString(),
  });
  if (!parsed.success) return { outcome: "invalid", shapes: existing };
  const next = [...without, parsed.data];
  persist(subject, next);
  return { outcome: "saved", shapes: next };
}

/** Remove one saved shape by id; returns the new list. */
export function removeSavedShape(subject: string, id: string): SavedShape[] {
  const next = listSavedShapes(subject).filter((shape) => shape.id !== id);
  persist(subject, next);
  return next;
}

function persist(subject: string, shapes: SavedShape[]): void {
  const key = storageKey(subject);
  const store = getStorage();
  if (!store) {
    memory.set(key, shapes);
    return;
  }
  try {
    store.setItem(key, JSON.stringify(shapes));
  } catch {
    // Quota/full: keep the in-memory copy so the session still works.
    memory.set(key, shapes);
  }
}
