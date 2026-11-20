/**
 * Draw & analyze — shared request schemas. The validate and analyze routes
 * parse the same wire shapes (draft geometry / AreaRef), so the zod definitions
 * live here once; the TypeScript AreaRef union in lib/server/areaRef.ts is the
 * hand-written counterpart these infer towards.
 */
import { z } from "zod";

export const positionSchema = z
  .array(z.number().finite())
  .min(2, "positions need at least [lng, lat]");

export const polygonSchema = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(positionSchema)).min(1),
});

export const lineStringSchema = z.object({
  type: z.literal("LineString"),
  coordinates: z.array(positionSchema).min(1),
});

/** Draft or committed shape geometry (LineString = still drawing). */
export const drawGeometrySchema = z.discriminatedUnion("type", [
  polygonSchema,
  lineStringSchema,
]);

export const areaRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("admin"),
    level: z.enum(["district", "tehsil", "ilr"]),
    areaId: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal("shape"),
    geometry: polygonSchema,
    name: z.string().trim().max(80).optional(),
  }),
]);

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
