import { districtsFc } from "@/lib/data/boundaries";
import type { SavedQueryInput } from "./repository";

/**
 * The four starter queries behind the empty state's "Add example queries".
 * District ids resolve against the same boundary dataset the server validates
 * with, so an example that can't resolve is skipped instead of failing.
 */

function districtByName(name: string): { areaId: string; name: string } | null {
  const feature = districtsFc.features.find(
    (candidate) => String(candidate.properties?.name ?? "") === name,
  );
  if (!feature) return null;
  const id = String(feature.properties?.id ?? "");
  if (!id) return null;
  return { areaId: id, name };
}

interface ExampleSpec {
  district: string;
  name: string;
  description: string;
  days: number;
  maxCloud: number;
  composite: "true-color" | "false-color" | "ndvi";
}

const SPECS: ExampleSpec[] = [
  {
    district: "Jaipur",
    name: "Kharif watch — Jaipur",
    description: "Jaipur · 120 days · ≤25% cloud · false colour",
    days: 120,
    maxCloud: 25,
    composite: "false-color",
  },
  {
    district: "Bikaner",
    name: "Drought monitor — Bikaner",
    description: "Bikaner · 180 days · ≤40% cloud · NDVI",
    days: 180,
    maxCloud: 40,
    composite: "ndvi",
  },
  {
    district: "Jodhpur",
    name: "Clear-sky archive — Jodhpur",
    description: "Jodhpur · 90 days · ≤10% cloud · true colour",
    days: 90,
    maxCloud: 10,
    composite: "true-color",
  },
  {
    district: "Udaipur",
    name: "Basin review — Udaipur",
    description: "Udaipur · 60 days · ≤30% cloud · false colour",
    days: 60,
    maxCloud: 30,
    composite: "false-color",
  },
];

/** Resolved examples — districts missing from the boundary data are skipped. */
export function exampleQueries(): SavedQueryInput[] {
  const queries: SavedQueryInput[] = [];
  for (const spec of SPECS) {
    const area = districtByName(spec.district);
    if (!area) continue;
    queries.push({
      name: spec.name,
      description: spec.description,
      area: { level: "district", ...area },
      dateRange: { mode: "relative", days: spec.days },
      maxCloud: spec.maxCloud,
      composite: spec.composite,
    });
  }
  return queries;
}
