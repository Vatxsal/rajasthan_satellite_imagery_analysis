import { districtsFc, ilrsFc, tehsilsFc } from "@/lib/data/boundaries";
import { pipAdminAgainst, type AdminHit } from "./hits";

/**
 * Admin point-in-polygon for the map inspector: the district / tehsil / ILR
 * under a clicked lng/lat, from the same bundled FeatureCollections the map
 * layers render (no network — the inspector's location section is local).
 */
export function pipAdmin(lng: number, lat: number): AdminHit {
  return pipAdminAgainst(districtsFc, tehsilsFc, ilrsFc, lng, lat);
}
