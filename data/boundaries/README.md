# Boundary datasets

| File | Contents | Source | Licence |
| --- | --- | --- | --- |
| `districts.geojson` | Current **41 districts** (28–30 Dec 2024 reorganisation) | OpenStreetMap via Overpass (`admin_level=5` relations in Rajasthan) | ODbL-1.0 — © OpenStreetMap contributors |
| `tehsils.geojson` | **224 tehsils** (Census 2011), re-parented to the 41-district layout | [Datameet `taluk_boundaries`](https://github.com/datameet/taluk_boundaries) (Census of India open data) | Upstream repository has no explicit licence file |
| `legacy/districts-census-2011-33.geojson` | Pre-reorganisation 33-district snapshot (validation baseline) | [Datameet `indian-district-boundaries`](https://github.com/datameet/indian-district-boundaries) | MIT |
| `legacy/tehsils-census-2011-224.geojson` | Census tehsil snapshot before re-parenting (id/geometry baseline) | [Datameet `taluk_boundaries`](https://github.com/datameet/taluk_boundaries) | Upstream repository has no explicit licence file |

## Provenance

- **Districts** were fetched on the `retrievedAt` date recorded in each feature's
  properties and the collection `metadata`. Census-era ids were preserved where
  they existed (`d-chittaurgarh`, `d-dhaulpur`, `d-ganganagar`, `d-jalor`);
  alternate spellings resolve through `DISTRICT_ID_ALIASES` in
  `lib/data/districtAliases.ts`.
- **Tehsils** keep their Census-2011 ids and geometry; only `parentId` /
  `districtId` were reassigned to the new districts by largest overlap area.
  Census polygons predate the 2023–24 tehsil splits, so a few tehsils sit
  mostly inside a different new district than their current official parent —
  the assignment follows district geometry.

## Refreshing

```bash
npx tsx scripts/fetch-districts-41.ts   # fetch districts + re-parent tehsils + OSM tehsil report
npm run validate:boundaries             # counts, names, geometry, tiling, area, legacy deltas
```

Do not run `scripts/fetch-datameet.ts` expecting the district set — it predates
the 41-district layout (see its header).

## Government / administrative use

These are community-mapped (OSM) and Census-era (2011) boundaries. For official
or administrative purposes cross-check against Survey of India topographic data
and the Rajasthan DoITC / RajDhara portal.
