# Rajasthan Imagery Explorer

A GIS dashboard for browsing, comparing and downloading Sentinel-2 satellite
imagery over Rajasthan (India), clipped to district → tehsil → ILR areas.

**Next.js 14 (App Router) · TypeScript · Tailwind CSS · MapLibre GL JS · Zustand · Radix UI · zod**

[![CI](https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis/actions/workflows/ci.yml/badge.svg)](https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis/actions/workflows/ci.yml)
License: MIT

Runs out of the box on an in-memory mock catalogue — no backend, database or API
keys required. Set `NEXT_PUBLIC_DATA_SOURCE=cdse` to switch to live Copernicus
Data Space Ecosystem (Sentinel-2) imagery — see
[Connecting Copernicus (CDSE)](#connecting-copernicus-cdse).

## Features

- **Shell**: 48px top bar (wordmark, selection breadcrumb, theme toggle, user
  menu), 56px icon rail, 320px contextual panel (collapse with `[`), full-screen
  map, docked 148px scene strip. Below 1024px the panel becomes a bottom sheet
  and the scene strip a swipeable list.
- **Filters**: District → Tehsil → ILR cascade, date presets (30d / 90d / 6m /
  Custom), cloud-cover slider + numeric input, composite segmented control
  (true colour / false colour / NDVI), sticky Search/Reset bar.
- **Scenes**: one card per acquisition day (daily mosaic), thumbnail, cloud %
  bar, tile count, **coverage % of the selected area**, MGRS tile ids; sort by
  lowest cloud or newest; skeleton + empty states.
- **Downloads** (per scene): one-click menu with 5 deep links into the
  Copernicus Browser / Data Space (per-tile `.SAFE` product ids, date, zoom and
  view all pre-filled) plus true-colour **PNG**, visual **GeoTIFF** and 8-band
  **analysis GeoTIFF** (FLOAT32 reflectance indices + band descriptions +
  nodata) rendered clipped to the selection (≤ 2500 px per side). Copy single
  or all product ids.
- **Map**: OpenFreeMap *positron* vector basemap with an Esri World Imagery
  satellite switcher, zoom/home/locate/fullscreen controls with screenshot
  menu, debounced Nominatim address search, selection highlight + fitBounds,
  live cursor coordinates, legend + composite legend.
- **Imagery overlay**: selecting a scene swaps a clipped PNG (transparent
  outside the AOI) into a MapLibre image source; XYZ tile mode renders
  native-resolution 512px tiles per pan/zoom with empty-tile short-circuits
  (outside area / out-of-band zoom / too-many-tiles) so quota is only spent on
  visible, in-area tiles.
- **Layers**: eye toggles for district / tehsil / ILR boundaries and the
  imagery overlay (inline opacity slider); Rajasthan state outline with casing
  lines so borders stay visible on any basemap.
- **Themes**: light/dark, persisted; boundaries/selection colours mirror the
  theme on the map.
- **Measure / Saved queries**: UI shells wired to the store state.

## Getting started

```bash
npm install
npm run dev        # http://localhost:3000
```

Requires **Node ≥ 20.9** (Node 20 LTS recommended; `.nvmrc` pins 20).

Other scripts:

```bash
npm run build      # production build (type-checks + lints)
npm run start      # serve the production build
npm run lint       # eslint (next/core-web-vitals)
npm run typecheck  # tsc --noEmit
npm test           # unit tests (node --test): downloads, Copernicus links
npm run generate:mock-data   # regenerate data/mock/*.geojson
node scripts/smoke.browser.cjs   # headless-browser end-to-end smoke (needs Chrome)
```

## Connecting Copernicus (CDSE)

Live Sentinel-2 imagery is already wired — nothing in the UI changes, flip one
env var.

### 1. Get credentials

Create a free account at
[dataspace.copernicus.eu](https://dataspace.copernicus.eu/), then create an
OAuth client under **Dashboard → Account Settings → OAuth clients**. Copy the
client ID and secret into `.env.local` (see `.env.example`):

```bash
CDSE_CLIENT_ID=your-client-id
CDSE_CLIENT_SECRET=your-client-secret
NEXT_PUBLIC_DATA_SOURCE=cdse
```

`CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` are **server-only** (no `NEXT_PUBLIC_`
prefix), so they never reach the browser bundle — verified by a build-time
bundle scan in the release checklist.

### 2. What happens under the hood

- `lib/data/index.ts` picks `cdseAdapter` when `NEXT_PUBLIC_DATA_SOURCE=cdse`.
  Boundaries still come from local GeoJSON; only scene search + imagery go to
  CDSE.
- **Scene search** (`POST /api/scenes`): STAC catalogue query (Sentinel-2
  L2A), cloud-cover filtered, grouped into one scene per day with per-tile
  product ids and coverage math. Areas larger than `MAX_AOI_KM2` are rejected
  before any quota is spent.
- **Imagery** (`GET|POST /api/imagery`): Sentinel Hub Process API render
  clipped to the polygon (RGBA PNG transparent outside the AOI, or GeoTIFF).
  Evalscripts in `lib/cdse/evalscripts.ts`; responses cached in-memory (LRU +
  TTL) keyed by geometry+date+composite+size+format; served as a **chunked
  stream** (see [Deploying to Vercel](#deploying-to-vercel)).
- **Tiles** (`GET /api/tiles/{z}/{x}/{y}`): one Process render per XYZ tile at
  native resolution, disk-cached when `TILE_CACHE_DIR` is set (off on Vercel).
- **Errors**: every route returns `{ code, message }`; auth/config/quota
  failures map to friendly codes (see [Troubleshooting](#troubleshooting)).
- **Health**: `GET /api/health/cdse` reports whether a token can be obtained —
  never returns secrets.

### 3. Environment variables

| Variable | Public? | Required | Default | Purpose |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_DATA_SOURCE` | public (build-time) | no | `mock` | `mock` = offline demo, `cdse` = live |
| `CDSE_CLIENT_ID` | **secret** | yes (cdse) | — | OAuth client id (server-only) |
| `CDSE_CLIENT_SECRET` | **secret** | yes (cdse) | — | OAuth client secret (server-only) |
| `CDSE_TOKEN_URL` | server | no | CDSE identity token endpoint | Override for proxied setups |
| `CDSE_SH_BASE_URL` | server | no | `https://sh.dataspace.copernicus.eu` | Sentinel Hub API base |
| `CDSE_WMTS_INSTANCE_ID` | server | no | unset | Enables the legacy WMTS tile proxy |
| `MAX_AOI_KM2` | server | no | `70000` | Reject areas larger than this (covers all Rajasthan) |
| `IMAGERY_CACHE_TTL_SECONDS` | server | no | `86400` | In-memory imagery/tile cache TTL |
| `RATE_LIMIT_PER_MIN` | server | no | `30` | Per-IP cap for API routes |
| `RATE_LIMIT_TILES_PER_MIN` | server | no | `240` | Per-IP cap for XYZ tiles |
| `DAILY_RENDER_BUDGET` | server | no | `3000` | Daily Process API render cap (UTC day, per instance; `0` = off) |
| `TILE_CACHE_DIR` | server | no | unset | On-disk tile cache (auto-disabled on Vercel) |
| `NEXT_PUBLIC_SITE_URL` | public (build-time) | no | `https://rajasthan-satellite-imagery-analysi.vercel.app` | Canonical origin for metadata, sitemap and robots |
| `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` | public (build-time) | no | unset | Google Search Console verification token |

## Deploying to Vercel

1. Push the repo to GitHub and import it in Vercel (framework auto-detected as
   Next.js; no extra build settings needed).
2. Add the env vars from the table above — `NEXT_PUBLIC_DATA_SOURCE=cdse`
   (public) plus `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (sensitive). Leave
   `TILE_CACHE_DIR` unset: serverless disks are ephemeral, and the app
   disables the disk cache automatically when `process.env.VERCEL` is set.
3. `vercel.json` pins the function region to **`fra1`** (Frankfurt) to keep
   the server↔Copernicus round-trip short. Build output stays default.
4. Deploy. Useful runtime settings: function `maxDuration` is exported per
   route (60s for renders, 30s for health); the default streaming runtime is
   used.

**Large downloads**: Vercel caps buffered function responses at 4.5 MB, but
*streamed* responses are exempt — `/api/imagery` therefore always responds
with `Transfer-Encoding: chunked` and no `Content-Length`, which is what keeps
PNG/GeoTIFF downloads (multi-MB) working on the Hobby plan.

**Rate limiting & budget are per instance**: in-memory counters reset on cold
starts and are not shared between instances, so they protect against runaway
usage rather than being a global quota. The CDSE-side quota remains the real
limit.

### Post-deploy checklist

```bash
curl -s https://<your-app>.vercel.app/api/health/cdse        # {"status":"ok",...}
curl -sI https://<your-app>.vercel.app/ | grep -i content-security-policy
node scripts/smoke.browser.cjs                               # BASE_URL=https://<your-app>.vercel.app
```

Then in the browser: pick a district → **Search imagery** → select a scene
(imagery overlay appears) → open a scene's menu → download PNG → switch
basemap → search an address. No console errors, no CSP violations.

## Security & guard rails

- **No secrets in the browser**: server-only env vars are validated by zod
  (`lib/env.ts`) and never imported into client components; the production
  client bundle is scanned for credential values before release.
- **Content-Security-Policy** + `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy` and HSTS are set for all routes in
  `next.config.mjs`. The CSP allow-lists only `self`, OpenFreeMap, Esri and
  Nominatim (MapLibre requires `worker-src blob:` and `script-src
  'unsafe-eval'` for its expression compiler).
- **CSRF**: POST routes reject requests whose `Origin` header points at
  another host (`403 CROSS_ORIGIN`); rate limiting + validation cover
  non-browser clients.
- **Input limits**: zod schemas on every route; JSON bodies capped at 512 KB
  (`413`), invalid JSON → `400`, geometry/date/enum fields strictly validated.
- **Quota**: per-IP fixed-window rate limits (API + tile buckets) and a daily
  render budget (`DAILY_RENDER_BUDGET`) with a `429` contract; upstream fetches
  have timeouts (20–60s) so a hung Copernicus call cannot pin a function.
- **Dependency audit**: `npm audit` reports 13 advisories that only resolve
  with major upgrades (Next 16 / MapLibre 6 / Tailwind 4 / eslint-config-next
  15). None are reachable at runtime here: the Next advisory concerns
  `next/image` (not used), the MapLibre advisory concerns HTML sanitisation
  sinks (the app renders no map HTML popups), and the rest are build-time
  tooling. Re-evaluate on the next major upgrade.

## SEO

- **Metadata** (`app/layout.tsx`): title template, description, keywords,
  canonical, OpenGraph/Twitter cards, `themeColor`, and a `robots` rule that
  indexes only real production deploys (Vercel previews and local dev stay
  `noindex`).
- **robots.txt** (`app/robots.ts`): allows `/`, disallows `/api/` so crawlers
  never spend Copernicus render quota; non-production deploys disallow all.
- **Sitemap** (`app/sitemap.ts`): `/` and `/about`.
- **Social preview** (`app/opengraph-image.tsx`, `app/twitter-image.tsx`):
  generated 1200×630 PNG card.
- **Structured data** (`components/seo/JsonLd.tsx`): JSON-LD `@graph` with
  `WebSite` + `WebApplication` (no fake ratings/reviews).
- **Crawlable copy**: `components/seo/SeoIntro.tsx` (screen-reader-visible
  intro on the dashboard) and an `/about` page (`app/about/page.tsx`).
- **API routes** send `X-Robots-Tag: noindex, nofollow` (`next.config.mjs`).

## Testing & CI

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
npm test            # compiles tsconfig.test.json → node --test (11 tests)
npm run build       # production build incl. type + lint pass
node scripts/smoke.browser.cjs   # full browser flow: map, basemap switch,
                                 # address search, scene search, streamed
                                 # imagery, CSP enforcement (requires Chrome)
```

`.github/workflows/ci.yml` runs on every push/PR to `main` with
`NEXT_PUBLIC_DATA_SOURCE=mock` (no secrets needed): install → typecheck →
lint → test → build → boot the production server and smoke-test `/` and
`/api/health/cdse`.

## Project layout

```
app/
  api/
    scenes/           # POST — STAC search → daily mosaic scenes (zod, origin guard)
    imagery/          # GET|POST — clipped PNG/GeoTIFF render (streamed)
    tiles/[z]/[x]/[y] # XYZ tile render + WMTS proxy + empty-tile short-circuits
    health/cdse/      # credential/token health (no secrets)
  layout.tsx, page.tsx, globals.css
components/
  shell/              # TopBar, Rail, Panel, ThemeSync
  filters/            # FiltersPanel, DateCalendar, MeasurePanel, SavedQueriesPanel
  layers/             # LayersPanel, Legend
  map/                # MapCanvas + controls, address search, basemap switcher, legends
  scenes/             # SceneStrip, SceneCard, ProductDialog (ids/links), DownloadDialog
  ui/                 # Button, Select, Slider, Segmented, Chip, Tooltip, Menu, ToastStack
data/
  boundaries/         # real Rajasthan district/tehsil GeoJSON (Datameet, Census 2011)
  mock/               # hand-made demo GeoJSON (districts, tehsils, ILRs)
lib/
  cdse/               # auth (OAuth token), STAC catalog, Process API, evalscripts,
                      # GeoTIFF metadata patcher, geometry/tiling maths, WMTS
  data/               # DataAdapter interface + mock/cdse adapters, boundaries, types
  server/             # API helpers (errors, origin guard, body caps, streams),
                      # area resolution, daily render budget
  map/                # basemap definitions, palettes, geojson helpers
  hooks/              # useAreas, useMediaQuery
  cache.ts            # in-memory LRU + optional disk tile cache
  rateLimit.ts        # fixed-window per-IP limiter (api | tiles buckets)
  env.ts              # zod-validated server env loader
  downloads.ts        # download formats + filename builders
  copernicusBrowser.ts# Copernicus Browser/Data Space deep-link builder
store/                # Zustand stores (app state + persisted theme)
scripts/              # mock-data generator, Datameet fetcher, unit + smoke tests
.github/workflows/    # CI
```

## Design tokens

Tokens live as CSS variables in `app/globals.css` and are mirrored into the
Tailwind theme in `tailwind.config.ts` (RGB triplets, so opacity modifiers like
`bg-surface/90` work). The dark theme is applied via `<html data-theme="dark">`.

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` | `#F6F5F1` | `#14151A` |
| `--surface` | `#FFFFFF` | `#1C1E24` |
| `--surface-2` | `#EFEDE7` | `#23262D` |
| `--border` | `#DAD7CF` | `#2E323B` |
| `--text` | `#1B1D22` | `#E8E6E1` |
| `--text-muted` | `#6B6E76` | `#9A9DA6` |
| `--accent` | `#C2410C` (terracotta) | `#F0713A` |
| `--accent-soft` | `#FBE9E0` | `#33221B` |
| `--accent-fg` | `#FFFFFF` | `#14151A` |
| `--success` / `--warning` / `--danger` | `#2F7D5B` / `#B7791F` / `#B42318` | `#4EA37B` / `#D6A04A` / `#E4574B` |

Conventions: 6px radius for inputs/buttons, 8px for panels, 1px hairline
borders, a single subtle shadow for floating map controls, Public Sans for UI
and IBM Plex Mono (tabular numerals) for coordinates, dates and scene IDs,
12/13/14/16/20px type scale.

Map overlays cannot read CSS variables, so their colours are mirrored per
theme in `lib/map/palette.ts` (accent line 2px + 10% fill for the selection,
text-coloured district/tehsil boundaries with solid/dashed styles, muted dotted
ILRs, accent dashed scene footprint — line style always differs so colour is
never the only signal).

### Changing the accent colour

1. Update `--accent`, `--accent-soft` and `--accent-fg` in both `:root`
   (light) and `[data-theme="dark"]` in `app/globals.css` (use RGB triplets,
   e.g. `--accent: 194 65 12;`).
2. Mirror the accent in `lib/map/palette.ts` (`MAP_PALETTES.light.accent` and
   `MAP_PALETTES.dark.accent`).

No other files need to change — Tailwind utilities (`text-accent`,
`bg-accent`, …) read the variables directly.

## Boundary data (Datameet, Census 2011)

The app prefers real Rajasthan boundaries from
[Datameet](https://datameet.org)'s Census 2011 compilations. To (re)fetch them
(network download — **not** part of the build):

```bash
npx tsx scripts/fetch-datameet.ts
```

It downloads district TopoJSON from
[`datameet/indian-district-boundaries`](https://github.com/datameet/indian-district-boundaries)
and taluk shapefiles from
[`datameet/taluk_boundaries`](https://github.com/datameet/taluk_boundaries),
filters to Rajasthan, simplifies geometry and writes
`data/boundaries/districts.geojson` and `data/boundaries/tehsils.geojson`.
The adapter falls back to the hand-made mock boundaries while those files are
empty. ILR units come from `data/mock/ilrs.geojson` until real ILR data is
added.

## Plugging in a real DataAdapter

All data access goes through one interface
([`lib/data/adapter.ts`](lib/data/adapter.ts)):

```ts
export interface DataAdapter {
  getDistricts(): Promise<District[]>;
  getTehsils(districtId: string): Promise<Tehsil[]>;
  getIlrs(tehsilId: string): Promise<Ilr[]>;
  searchScenes(params: SearchParams): Promise<Scene[]>;
}
```

Components and the store only import the `dataAdapter` singleton from
[`lib/data/index.ts`](lib/data/index.ts). Two implementations ship:
`mockAdapter` (in-memory demo) and `cdseAdapter` (calls the `/api` routes
above). To add another (PostGIS, Supabase, a different STAC…), implement the
interface and swap the singleton in that one file — everything downstream
(cascading selects, scene strip, `runSearch`, boundary layers) keeps working.

## Troubleshooting

| Symptom | `code` | Fix |
| --- | --- | --- |
| Search/download fails immediately | `RATE_LIMITED` | Per-IP limit hit — wait for `Retry-After` or raise `RATE_LIMIT_PER_MIN` |
| Renders stop after heavy use | `DAILY_BUDGET_EXCEEDED` | Raise `DAILY_RENDER_BUDGET` (resets 00:00 UTC) |
| "Area too large" | `AOI_TOO_LARGE` | Pick a tehsil/ILR or raise `MAX_AOI_KM2` |
| Download rejected | `DOWNLOAD_TOO_LARGE` | Requested px > 2500 — pick a smaller area |
| `cdse` mode, everything 500s | `CDSE_CONFIG` | Set `CDSE_CLIENT_ID`/`CDSE_CLIENT_SECRET` in `.env.local` (or Vercel env) |
| Auth failures | `CDSE_AUTH` / 401 | Recreate the OAuth client; check for trailing whitespace |
| Upstream failures | `UPSTREAM_ERROR` (502) | Copernicus outage/timeout — retry shortly |
| Tiles 404 | `WMTS_DISABLED` | Expected: legacy WMTS mode needs `CDSE_WMTS_INSTANCE_ID`; native mode needs `?date=&areaId=&level=` |
| `npm run dev` exits with EADDRINUSE | — | Another process holds :3000 (e.g. a stale server) — stop it or use `npm run dev -- -p 3001` |

## Attribution & data sources

- **Sentinel-2 data** © ESA / Copernicus data via the
  [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/) —
  subject to the Copernicus licensing terms; include attribution when
  republishing imagery.
- **Basemaps**: [OpenFreeMap](https://openfreemap.org/) *positron* style
  (OpenMapTiles / © OpenStreetMap contributors, ODbL) and
  [Esri World Imagery](https://www.esri.com/en-us/what-is-gis/overview)
  (Esri, Maxar, Earthstar Geographics) — keep the attribution line visible when
  publishing screenshots.
- **Geocoding**: [Nominatim](https://nominatim.org/) search — ©
  OpenStreetMap contributors, ODbL; usage follows their usage policy.
- **Boundaries**: [Datameet](https://datameet.org) Census 2011 compilations
  (Census of India open data) — credit Datameet / Census of India.
- **Libraries**: [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause),
  [Next.js](https://nextjs.org/) (MIT), [zod](https://zod.dev/) (MIT),
  [turf](https://turfjs.org/) (MIT), Radix UI (MIT), lucide (ISC).
  UI fonts: Public Sans & IBM Plex Mono (SIL OFL), bundled Geist fonts (MIT).

## License

[MIT](LICENSE) © Vatsal Mishra
