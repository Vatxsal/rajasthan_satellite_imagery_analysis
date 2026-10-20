<div align="center">

# 🛰️ Rajasthan Imagery Explorer

**Browse, compare and download Sentinel-2 satellite imagery over Rajasthan, clipped to District → Tehsil → ILR areas.**

[![CI](https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis/actions/workflows/ci.yml/badge.svg)](https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-C2410C.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020.9-2F7D5B?logo=nodedotjs&logoColor=white)](.nvmrc)
[![Data](https://img.shields.io/badge/Data-Copernicus%20Sentinel--2-0B5FA5)](https://dataspace.copernicus.eu/)

![Next.js](https://img.shields.io/badge/Next.js_14-000000?logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-06B6D4?logo=tailwindcss&logoColor=white)
![MapLibre](https://img.shields.io/badge/MapLibre_GL_JS-396CB2?logo=maplibre&logoColor=white)
![Zustand](https://img.shields.io/badge/Zustand-443E38)
![Radix UI](https://img.shields.io/badge/Radix_UI-161618?logo=radixui&logoColor=white)
![zod](https://img.shields.io/badge/zod-3E67B1?logo=zod&logoColor=white)

[Quick Start](#-quick-start) · [Features](#-features) · [Connect Copernicus](#-connecting-copernicus-cdse) · [Deploy](#-deploying-to-vercel) · [Troubleshooting](#-troubleshooting)

</div>

<!-- Tip: add a screenshot or GIF here, e.g.
<p align="center"><img src="docs/screenshot.png" alt="Rajasthan Imagery Explorer" width="900"></p>
-->

---

> **Zero-setup demo.** The app runs out of the box on an in-memory mock catalogue, with no backend, database or API keys required. Set `NEXT_PUBLIC_DATA_SOURCE=cdse` to switch to live Copernicus Data Space Ecosystem (Sentinel-2) imagery. See [Connecting Copernicus](#-connecting-copernicus-cdse).

## 📑 Table of Contents

- [Features](#-features)
- [Quick Start](#-quick-start)
- [Architecture](#-architecture)
- [Connecting Copernicus (CDSE)](#-connecting-copernicus-cdse)
- [Deploying to Vercel](#-deploying-to-vercel)
- [Security & Guard Rails](#-security--guard-rails)
- [SEO](#-seo)
- [Testing & CI](#-testing--ci)
- [Project Layout](#-project-layout)
- [Design Tokens](#-design-tokens)
- [Boundary Data](#-boundary-data-datameet-census-2011)
- [Plugging in a Real DataAdapter](#-plugging-in-a-real-dataadapter)
- [Troubleshooting](#-troubleshooting)
- [Attribution & Data Sources](#-attribution--data-sources)
- [License](#-license)

---

## ✨ Features

| | Feature | What you get |
| :-: | --- | --- |
| 🧭 | **Shell** | 48px top bar (wordmark, selection breadcrumb, theme toggle, user menu), 56px icon rail, 320px contextual panel (collapse with `[`), full-screen map and a docked 148px scene strip. Below 1024px the panel becomes a bottom sheet and the scene strip a swipeable list. |
| 🔎 | **Filters** | District → Tehsil → ILR cascade, date presets (30d / 90d / 6m / Custom), cloud-cover slider with numeric input, composite control (true colour / false colour / NDVI), sticky Search / Reset bar. |
| 🖼️ | **Scenes** | One card per acquisition day (daily mosaic) with thumbnail, cloud % bar, tile count, **coverage % of the selected area** and MGRS tile ids. Sort by lowest cloud or newest, with skeleton and empty states. |
| ⬇️ | **Downloads** | Per-scene menu with 5 deep links into Copernicus Browser / Data Space (per-tile `.SAFE` product ids, date, zoom and view pre-filled), plus true-colour **PNG**, visual **GeoTIFF** and 8-band **analysis GeoTIFF** (FLOAT32 reflectance indices, band descriptions, nodata), all clipped to the selection (≤ 2500 px per side). Copy single or all product ids. |
| 🗺️ | **Map** | OpenFreeMap *positron* vector basemap with an Esri World Imagery switcher, zoom / home / locate / fullscreen controls with screenshot menu, debounced Nominatim address search, selection highlight with `fitBounds`, live cursor coordinates, legend and composite legend. |
| 🛰️ | **Imagery overlay** | Selecting a scene swaps a clipped PNG (transparent outside the AOI) into a MapLibre image source. XYZ tile mode renders native-resolution 512px tiles per pan/zoom, with empty-tile short-circuits (outside area, out-of-band zoom, too many tiles) so quota is only spent on visible, in-area tiles. |
| 🧱 | **Layers** | Eye toggles for district / tehsil / ILR boundaries and the imagery overlay (inline opacity slider). Rajasthan state outline with casing lines keeps borders visible on any basemap. |
| 🌗 | **Themes** | Light / dark, persisted. Boundary and selection colours mirror the theme on the map. |
| 📏 | **Measure / Saved queries** | UI shells wired to the store state. |

---

## 🚀 Quick Start

> **Requires Node ≥ 20.9** (Node 20 LTS recommended; `.nvmrc` pins 20).

```bash
npm install
npm run dev        # http://localhost:3000
```

<details>
<summary><b>All available scripts</b></summary>

```bash
npm run build      # production build (type-checks + lints)
npm run start      # serve the production build
npm run lint       # eslint (next/core-web-vitals)
npm run typecheck  # tsc --noEmit
npm test           # unit tests (node --test): downloads, Copernicus links
npm run generate:mock-data   # regenerate data/mock/*.geojson
node scripts/smoke.browser.cjs   # headless-browser end-to-end smoke (needs Chrome)
```

</details>

---

## 🏗️ Architecture

```mermaid
flowchart LR
    UI["Next.js UI<br/>MapLibre · Zustand"] --> AD{"dataAdapter"}
    AD -->|"mock (default)"| MOCK["In-memory<br/>mock catalogue"]
    AD -->|"cdse"| API["Next.js API routes<br/>/api/scenes · /api/imagery · /api/tiles"]
    API --> STAC["CDSE STAC<br/>scene search"]
    API --> SH["Sentinel Hub<br/>Process API"]
    API --> CACHE[("LRU + TTL cache<br/>optional disk tiles")]
```

Components and the store only talk to a single `dataAdapter` singleton, so the data source can be swapped without touching the UI.

---

## 🌍 Connecting Copernicus (CDSE)

Live Sentinel-2 imagery is already wired in. Nothing in the UI changes; you only flip one env var.

### 1. Get credentials

Create a free account at [dataspace.copernicus.eu](https://dataspace.copernicus.eu/), then create an OAuth client under **Dashboard → Account Settings → OAuth clients**. Copy the client ID and secret into `.env.local` (see `.env.example`):

```bash
CDSE_CLIENT_ID=your-client-id
CDSE_CLIENT_SECRET=your-client-secret
NEXT_PUBLIC_DATA_SOURCE=cdse
```

> 🔐 `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` are **server-only** (no `NEXT_PUBLIC_` prefix), so they never reach the browser bundle. This is verified by a build-time bundle scan in the release checklist.

### 2. What happens under the hood

| Concern | Route | Behaviour |
| --- | --- | --- |
| **Adapter** | `lib/data/index.ts` | Picks `cdseAdapter` when `NEXT_PUBLIC_DATA_SOURCE=cdse`. Boundaries still come from local GeoJSON; only scene search and imagery go to CDSE. |
| **Scene search** | `POST /api/scenes` | STAC catalogue query (Sentinel-2 L2A), cloud-cover filtered, grouped into one scene per day with per-tile product ids and coverage math. Areas larger than `MAX_AOI_KM2` are rejected before any quota is spent. |
| **Imagery** | `GET\|POST /api/imagery` | Sentinel Hub Process API render clipped to the polygon (RGBA PNG transparent outside the AOI, or GeoTIFF). Evalscripts live in `lib/cdse/evalscripts.ts`. Responses are cached in-memory (LRU + TTL) keyed by geometry + date + composite + size + format, and served as a **chunked stream** (see [Deploying to Vercel](#-deploying-to-vercel)). |
| **Tiles** | `GET /api/tiles/{z}/{x}/{y}` | One Process render per XYZ tile at native resolution, disk-cached when `TILE_CACHE_DIR` is set (off on Vercel). |
| **Errors** | all routes | Every route returns `{ code, message }`. Auth, config and quota failures map to friendly codes (see [Troubleshooting](#-troubleshooting)). |
| **Health** | `GET /api/health/cdse` | Reports whether a token can be obtained. Never returns secrets. |

### 3. Environment variables

| Variable | Visibility | Required | Default | Purpose |
| --- | --- | :-: | --- | --- |
| `NEXT_PUBLIC_DATA_SOURCE` | public (build-time) | no | `mock` | `mock` = offline demo, `cdse` = live |
| `CDSE_CLIENT_ID` | 🔒 **secret** | yes (cdse) | n/a | OAuth client id (server-only) |
| `CDSE_CLIENT_SECRET` | 🔒 **secret** | yes (cdse) | n/a | OAuth client secret (server-only) |
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

---

## ▲ Deploying to Vercel

1. **Import** the repo from GitHub into Vercel (framework auto-detected as Next.js; no extra build settings needed).
2. **Add env vars** from the table above: `NEXT_PUBLIC_DATA_SOURCE=cdse` (public) plus `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (sensitive). Leave `TILE_CACHE_DIR` unset: serverless disks are ephemeral, and the app disables the disk cache automatically when `process.env.VERCEL` is set.
3. **Region**: `vercel.json` pins the function region to **`fra1`** (Frankfurt) to keep the server ↔ Copernicus round-trip short. Build output stays default.
4. **Deploy.** Function `maxDuration` is exported per route (60s for renders, 30s for health); the default streaming runtime is used.

> 📦 **Large downloads.** Vercel caps buffered function responses at 4.5 MB, but *streamed* responses are exempt. `/api/imagery` therefore always responds with `Transfer-Encoding: chunked` and no `Content-Length`, which keeps multi-MB PNG/GeoTIFF downloads working on the Hobby plan.

> ⚠️ **Rate limiting and budget are per instance.** In-memory counters reset on cold starts and are not shared between instances, so they protect against runaway usage rather than acting as a global quota. The CDSE-side quota remains the real limit.

### ✅ Post-deploy checklist

```bash
curl -s https://<your-app>.vercel.app/api/health/cdse        # {"status":"ok",...}
curl -sI https://<your-app>.vercel.app/ | grep -i content-security-policy
node scripts/smoke.browser.cjs                               # BASE_URL=https://<your-app>.vercel.app
```

Then in the browser:

- [ ] Pick a district → **Search imagery**
- [ ] Select a scene (imagery overlay appears)
- [ ] Open a scene's menu → download PNG
- [ ] Switch basemap → search an address
- [ ] No console errors, no CSP violations

---

## 🛡️ Security & Guard Rails

| Area | Protection |
| --- | --- |
| **Secrets** | Server-only env vars are validated by zod (`lib/env.ts`) and never imported into client components. The production client bundle is scanned for credential values before release. |
| **Headers** | Content-Security-Policy plus `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and HSTS on all routes (`next.config.mjs`). The CSP allow-lists only `self`, OpenFreeMap, Esri and Nominatim (MapLibre requires `worker-src blob:` and `script-src 'unsafe-eval'` for its expression compiler). |
| **CSRF** | POST routes reject requests whose `Origin` header points at another host (`403 CROSS_ORIGIN`). Rate limiting and validation cover non-browser clients. |
| **Input limits** | zod schemas on every route. JSON bodies capped at 512 KB (`413`), invalid JSON → `400`, geometry / date / enum fields strictly validated. |
| **Quota** | Per-IP fixed-window rate limits (API + tile buckets) and a daily render budget (`DAILY_RENDER_BUDGET`) with a `429` contract. Upstream fetches have 20-60s timeouts so a hung Copernicus call cannot pin a function. |

<details>
<summary><b>Dependency audit</b></summary>

`npm audit` reports 13 advisories that only resolve with major upgrades (Next 16 / MapLibre 6 / Tailwind 4 / eslint-config-next 15). None are reachable at runtime here:

- The Next advisory concerns `next/image` (not used).
- The MapLibre advisory concerns HTML sanitisation sinks (the app renders no map HTML popups).
- The rest are build-time tooling.

Re-evaluate on the next major upgrade.

</details>

---

## 🔍 SEO

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

---

## 🧪 Testing & CI

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
npm test            # compiles tsconfig.test.json → node --test (11 tests)
npm run build       # production build incl. type + lint pass
node scripts/smoke.browser.cjs   # full browser flow: map, basemap switch,
                                 # address search, scene search, streamed
                                 # imagery, CSP enforcement (requires Chrome)
```

`.github/workflows/ci.yml` runs on every push/PR to `main` with `NEXT_PUBLIC_DATA_SOURCE=mock` (no secrets needed):

```text
install → typecheck → lint → test → build → boot prod server → smoke-test "/" and "/api/health/cdse"
```

---

## 🗂️ Project Layout

```text
app/
  api/
    scenes/             # POST: STAC search → daily mosaic scenes (zod, origin guard)
    imagery/            # GET|POST: clipped PNG/GeoTIFF render (streamed)
    tiles/[z]/[x]/[y]   # XYZ tile render + WMTS proxy + empty-tile short-circuits
    health/cdse/        # credential/token health (no secrets)
  layout.tsx, page.tsx, globals.css
components/
  shell/                # TopBar, Rail, Panel, ThemeSync
  filters/              # FiltersPanel, DateCalendar, MeasurePanel, SavedQueriesPanel
  layers/               # LayersPanel, Legend
  map/                  # MapCanvas + controls, address search, basemap switcher, legends
  scenes/               # SceneStrip, SceneCard, ProductDialog (ids/links), DownloadDialog
  ui/                   # Button, Select, Slider, Segmented, Chip, Tooltip, Menu, ToastStack
data/
  boundaries/           # real Rajasthan district/tehsil GeoJSON (Datameet, Census 2011)
  mock/                 # hand-made demo GeoJSON (districts, tehsils, ILRs)
lib/
  cdse/                 # auth (OAuth token), STAC catalog, Process API, evalscripts,
                        # GeoTIFF metadata patcher, geometry/tiling maths, WMTS
  data/                 # DataAdapter interface + mock/cdse adapters, boundaries, types
  server/               # API helpers (errors, origin guard, body caps, streams),
                        # area resolution, daily render budget
  map/                  # basemap definitions, palettes, geojson helpers
  hooks/                # useAreas, useMediaQuery
  cache.ts              # in-memory LRU + optional disk tile cache
  rateLimit.ts          # fixed-window per-IP limiter (api | tiles buckets)
  env.ts                # zod-validated server env loader
  downloads.ts          # download formats + filename builders
  copernicusBrowser.ts  # Copernicus Browser/Data Space deep-link builder
store/                  # Zustand stores (app state + persisted theme)
scripts/                # mock-data generator, Datameet fetcher, unit + smoke tests
.github/workflows/      # CI
```

---

## 🎨 Design Tokens

Tokens live as CSS variables in `app/globals.css` and are mirrored into the Tailwind theme in `tailwind.config.ts` (RGB triplets, so opacity modifiers like `bg-surface/90` work). The dark theme is applied via `<html data-theme="dark">`.

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

**Conventions:** 6px radius for inputs/buttons, 8px for panels, 1px hairline borders, a single subtle shadow for floating map controls, Public Sans for UI and IBM Plex Mono (tabular numerals) for coordinates, dates and scene IDs, and a 12/13/14/16/20px type scale.

Map overlays cannot read CSS variables, so their colours are mirrored per theme in `lib/map/palette.ts` (accent line 2px + 10% fill for the selection, text-coloured district/tehsil boundaries with solid/dashed styles, muted dotted ILRs, accent dashed scene footprint). Line style always differs so colour is never the only signal.

<details>
<summary><b>Changing the accent colour</b></summary>

1. Update `--accent`, `--accent-soft` and `--accent-fg` in both `:root` (light) and `[data-theme="dark"]` in `app/globals.css` (use RGB triplets, e.g. `--accent: 194 65 12;`).
2. Mirror the accent in `lib/map/palette.ts` (`MAP_PALETTES.light.accent` and `MAP_PALETTES.dark.accent`).

No other files need to change. Tailwind utilities (`text-accent`, `bg-accent`, …) read the variables directly.

</details>

---

## 🧭 Boundary Data (Datameet, Census 2011)

The app prefers real Rajasthan boundaries from [Datameet](https://datameet.org)'s Census 2011 compilations. To (re)fetch them (network download, **not** part of the build):

```bash
npx tsx scripts/fetch-datameet.ts
```

It downloads district TopoJSON from [`datameet/indian-district-boundaries`](https://github.com/datameet/indian-district-boundaries) and taluk shapefiles from [`datameet/taluk_boundaries`](https://github.com/datameet/taluk_boundaries), filters to Rajasthan, simplifies geometry and writes `data/boundaries/districts.geojson` and `data/boundaries/tehsils.geojson`.

The adapter falls back to the hand-made mock boundaries while those files are empty. ILR units come from `data/mock/ilrs.geojson` until real ILR data is added.

---

## 🔌 Plugging in a Real DataAdapter

All data access goes through one interface ([`lib/data/adapter.ts`](lib/data/adapter.ts)):

```ts
export interface DataAdapter {
  getDistricts(): Promise<District[]>;
  getTehsils(districtId: string): Promise<Tehsil[]>;
  getIlrs(tehsilId: string): Promise<Ilr[]>;
  searchScenes(params: SearchParams): Promise<Scene[]>;
}
```

Components and the store only import the `dataAdapter` singleton from [`lib/data/index.ts`](lib/data/index.ts). Two implementations ship: `mockAdapter` (in-memory demo) and `cdseAdapter` (calls the `/api` routes above).

To add another (PostGIS, Supabase, a different STAC…), implement the interface and swap the singleton in that one file. Everything downstream (cascading selects, scene strip, `runSearch`, boundary layers) keeps working.

---

## 🩺 Troubleshooting

| Symptom | `code` | Fix |
| --- | --- | --- |
| Search/download fails immediately | `RATE_LIMITED` | Per-IP limit hit. Wait for `Retry-After` or raise `RATE_LIMIT_PER_MIN` |
| Renders stop after heavy use | `DAILY_BUDGET_EXCEEDED` | Raise `DAILY_RENDER_BUDGET` (resets 00:00 UTC) |
| "Area too large" | `AOI_TOO_LARGE` | Pick a tehsil/ILR or raise `MAX_AOI_KM2` |
| Download rejected | `DOWNLOAD_TOO_LARGE` | Requested px > 2500. Pick a smaller area |
| `cdse` mode, everything 500s | `CDSE_CONFIG` | Set `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` in `.env.local` (or Vercel env) |
| Auth failures | `CDSE_AUTH` / 401 | Recreate the OAuth client; check for trailing whitespace |
| Upstream failures | `UPSTREAM_ERROR` (502) | Copernicus outage/timeout. Retry shortly |
| Tiles 404 | `WMTS_DISABLED` | Expected: legacy WMTS mode needs `CDSE_WMTS_INSTANCE_ID`; native mode needs `?date=&areaId=&level=` |
| `npm run dev` exits with `EADDRINUSE` | n/a | Another process holds :3000 (e.g. a stale server). Stop it or use `npm run dev -- -p 3001` |

---

## 📜 Attribution & Data Sources

| Source | Credit |
| --- | --- |
| **Sentinel-2 data** | © ESA / Copernicus data via the [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/), subject to the Copernicus licensing terms. Include attribution when republishing imagery. |
| **Basemaps** | [OpenFreeMap](https://openfreemap.org/) *positron* style (OpenMapTiles / © OpenStreetMap contributors, ODbL) and [Esri World Imagery](https://www.esri.com/en-us/what-is-gis/overview) (Esri, Maxar, Earthstar Geographics). Keep the attribution line visible when publishing screenshots. |
| **Geocoding** | [Nominatim](https://nominatim.org/) search, © OpenStreetMap contributors, ODbL. Usage follows their usage policy. |
| **Boundaries** | [Datameet](https://datameet.org) Census 2011 compilations (Census of India open data). Credit Datameet / Census of India. |
| **Libraries** | [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause), [Next.js](https://nextjs.org/) (MIT), [zod](https://zod.dev/) (MIT), [turf](https://turfjs.org/) (MIT), Radix UI (MIT), lucide (ISC). UI fonts: Public Sans & IBM Plex Mono (SIL OFL), bundled Geist fonts (MIT). |

---

## 📄 License

Released under the [MIT License](LICENSE) © Vatsal Mishra

<div align="center">

<sub>Built with Next.js, MapLibre and Copernicus Sentinel-2 data · Made for Rajasthan 🇮🇳</sub>

</div>
