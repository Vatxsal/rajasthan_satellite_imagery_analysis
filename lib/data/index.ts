import type { DataAdapter } from "./adapter";
import { cdseAdapter } from "./cdseAdapter";
import { dataSource } from "@/lib/dataSource";
import { mockAdapter } from "./mockAdapter";

export type {
  AreaLevel,
  BBox,
  CompositeId,
  District,
  Ilr,
  Scene,
  SceneProduct,
  SearchParams,
  Tehsil,
} from "./types";
export type { DataAdapter } from "./adapter";

/**
 * Swap via NEXT_PUBLIC_DATA_SOURCE env var (see .env.example):
 *   mock (default) — in-memory catalogue
 *   cdse           — live Copernicus/Sentinel Hub via /api routes
 */
export const dataAdapter: DataAdapter = dataSource === "cdse" ? cdseAdapter : mockAdapter;

/** True while the mock adapter is wired up (TopBar shows a "Demo data" chip). */
export const isDemoData = dataSource !== "cdse";
