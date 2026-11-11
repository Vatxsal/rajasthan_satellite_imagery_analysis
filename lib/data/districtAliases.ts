/**
 * Alternate spellings for current district ids. Share links and API params
 * written under either spelling must keep resolving after the 41-district
 * reorganisation (Census-era ids were preserved, so most legacy links already
 * match — these cover name-based variants). Client-safe: no imports.
 */
export const DISTRICT_ID_ALIASES: Record<string, string> = {
  "d-chittorgarh": "d-chittaurgarh",
  "d-dholpur": "d-dhaulpur",
  "d-jalore": "d-jalor",
  "d-sri-ganganagar": "d-ganganagar",
  "d-salumbar": "d-salumber",
};

/** Maps an incoming district id through DISTRICT_ID_ALIASES (identity by default). */
export function resolveDistrictId(id: string): string {
  return DISTRICT_ID_ALIASES[id] ?? id;
}
