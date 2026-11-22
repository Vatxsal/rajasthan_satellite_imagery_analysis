<div align="center">

# 🛰️ Rajasthan Imagery Explorer

**Browse, compare and download Sentinel-2 imagery over Rajasthan, clipped to District → Tehsil → ILR areas, see what changed between two dates, and email the report.**

[![CI](https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis/actions/workflows/ci.yml/badge.svg)](https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-C2410C.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020.9-2F7D5B?logo=nodedotjs&logoColor=white)](.nvmrc)
[![Data](https://img.shields.io/badge/Data-Copernicus%20Sentinel--2-0B5FA5)](https://dataspace.copernicus.eu/)

Next.js 14 · TypeScript · Tailwind · MapLibre GL JS · Zustand · Radix UI · zod · Nodemailer

[Quick Start](#-quick-start) · [Features](#-features) · [Configuration](#-configuration) · [Change Detection](#-change-detection) · [Email Report](#-email-report) · [Deploy](#-deploy-to-vercel) · [Roadmap](#-roadmap) · [Troubleshooting](#-troubleshooting)

</div>

<!-- Add screenshots to docs/screenshots and uncomment:
<p align="center"><img src="docs/screenshots/overview.png" alt="Rajasthan Imagery Explorer" width="900"></p>
-->

> **Zero-setup demo.** With defaults the app runs on an in-memory mock catalogue: no keys, database or backend. Set `NEXT_PUBLIC_DATA_SOURCE=cdse` for live Copernicus imagery.

---

## ✨ Features

| | Feature | What you get |
| :-: | --- | --- |
| 🔎 | **Filters & scenes** | District → Tehsil → ILR cascade, date presets and a calendar that highlights dates with scenes, cloud slider, true / false colour / NDVI. One card per acquisition day with cloud %, **coverage % of the area**, UTC time and scene id. |
| 🗺️ | **Map & imagery** | OpenFreeMap basemap (English labels) with an Esri satellite switcher, **native-resolution 512 px tiles** (bicubic upscaling, zoom band up to z15) clipped to the selected area, opacity slider, legends, address search, boundary layers, light / dark themes. |
| ⬇️ | **Downloads** | PNG preview for every role; **GeoTIFF (visual, 8-bit)** and **GeoTIFF (analysis, FLOAT32 bands)** for SSO; Copernicus Browser deep links. Clipped to the selection, up to 2500 px per side (guest PNG capped at 1024 px). |
| 🔍 | **Change detection** | Compare two dates: **Swipe**, classified **Changes** map, **Stats** (by class and tehsil), **Events** list with numbered map markers, **Summary**, and exports. Guests run tehsil / ILR at default tuning (3/day); SSO adds district level, adjustable sensitivity / minimum patch, PNG + GeoTIFF / CSV / GeoJSON exports (50/day). |
| 🧭 | **Map inspector** | Click the map (or focus **Inspect map centre** + Enter) for one Google-Maps-style card: coordinates with copy, *Select this tehsil / district*, field details with an NDVI sparkline, change-event facts, a **Sample NDVI here** spot check, and Copernicus Browser / Google Maps links. Bottom sheet on phones; Esc closes. See [Map inspector](#-map-inspector). |
| 🌾 | **Fields & crops** | SSO-only: load Fields of the World parcel boundaries for the current view (≤ 25 km²), run a 12-month **cropping pattern** (fallow / kharif / rabi / double-cropped …), paint the map by pattern, curve group or confidence, isolate classes from the legend, and open any parcel in the map inspector. See [Fields & crops on the map](#-fields--crops-on-the-map). |
| 🛰️ | **High-resolution imagery** | SSO-only NRSC Bhoonidhi LISS-IV scenes (5.8 m, false colour) for the selected area: scene picker, opacity, and a **Swipe vs Sentinel-2** divider. Guests can request an area by email with the AOI attached. See [High-resolution imagery](#-high-resolution-imagery-bhoonidhi). |
| 🤖 | **AI summary** | SSO-only Gemini briefing of a comparison in English or हिन्दी, built only from the computed statistics (30/day). |
| 📧 | **Email report** | SSO-only: one click (**Send report to mail**) emails the top events, stats, AI summary, change-map image, `events.csv` and a link that reopens the analysis. Fixed-recipient mode for production. |
| 🔐 | **Access gate & roles** | `/login` hero page with shared-credential **Sign in**, **Continue as guest** (limited role), and an in-card **Request access** form. Locked features show a padlock popover; the API returns `403 FORBIDDEN_ROLE`. See [Roles & capabilities](#roles--capabilities). |
| 📌 | **Saved queries** | Save the current filters (area, dates, cloud, composite — plus compare tuning for SSO) as a named query; **Run** re-applies everything in one click. Pin, duplicate, edit, delete with Undo, export/import JSON. Guests keep 5 in this browser, SSO 50 per profile (Supabase or browser storage). See [Saved queries](#-saved-queries). |

---

## 🚀 Quick Start

> Requires **Node ≥ 20.9** (`.nvmrc` pins 20).

```bash
git clone https://github.com/Vatxsal/rajasthan_satellite_imagery_analysis.git
cd rajasthan_satellite_imagery_analysis
npm install
cp .env.example .env.local     # PowerShell: Copy-Item .env.example .env.local
npm run dev                    # http://localhost:3000
```

<details>
<summary><b>Scripts</b></summary>

```bash
npm run verify         # typecheck + lint + test + build (what CI runs)
npm run build / start  # production build / serve it
npm run lint / typecheck / test
npm run email:preview  # render email fixtures to .email-preview/
npm run email:test     # send one test report to EMAIL_TEST_RECIPIENT
npm run auth:new-user  # mint an SSO entry: password printed once, JSON for SSO_USERS
npm run auth:hash      # hash a password for an existing SSO_USERS entry (argv or stdin)
npm run docs:permissions  # regenerate the capability table below from lib/auth/permissions.ts
npx tsx scripts/fetch-districts-41.ts # refresh district boundaries + re-parent tehsils (not part of the build)
npm run validate:boundaries           # validate counts, tiling, area and legacy deltas
node scripts/smoke.browser.cjs      # headless-browser smoke test (needs Chrome)
node scripts/sharpness.browser.cjs      # imagery sharpness evidence (bicubic z13–15; needs Chrome)
node scripts/verify-swipe-basemap.browser.cjs  # Swipe dates/basemap mode harness (needs Chrome)
node scripts/verify-inspector-fields.browser.cjs  # map inspector + Fields & crops live harness (47 checks; needs Chrome + dev server)
node scripts/warm-fields.browser.cjs  # warm the server-side fields cache for the harness viewports
```

</details>

---

## 🏗️ Architecture

```mermaid
flowchart LR
    UI["Next.js UI<br/>MapLibre · Zustand"] --> AD{"dataAdapter"}
    AD -->|"mock (default)"| MOCK["Mock catalogue"]
    AD -->|"cdse"| API["API routes<br/>scenes · imagery · tiles · compare"]
    API --> SH["Copernicus<br/>STAC + Process API"]
    API --> GEM["Gemini<br/>(optional)"]
    API --> SMTP["SMTP / Resend<br/>(email)"]
    API --> CACHE[("LRU + TTL cache")]
    BND[("Boundary GeoJSON")] --> UI
```

All Copernicus, Gemini and email calls are **server-side**; the browser never sees a credential. Swapping the data source only means swapping the `dataAdapter` singleton.

**Outbound access** (for firewalls and government hosting):

| Service | From | Used for | Needed |
| --- | --- | --- | --- |
| `identity.dataspace.copernicus.eu`, `sh.dataspace.copernicus.eu` | server | token, scene search, renders | yes (live mode) |
| OpenFreeMap, Esri World Imagery, Nominatim | browser | basemap, satellite basemap, address search | yes (or self-host) |
| Google Gemini API | server | AI summary | optional |
| Your SMTP host or Resend | server | email report | optional |
| `<project>.supabase.co` | server | saved-query storage | optional |
| `challenges.cloudflare.com` | browser + server | Turnstile CAPTCHA | optional |

---

## ⚙️ Configuration

`.env.example` is the source of truth and mirrors `lib/env.ts` (validated by zod; missing server vars produce a clear error).

| Variable | Type | Default | Purpose |
| --- | :-: | --- | --- |
| `NEXT_PUBLIC_DATA_SOURCE` | public | `mock` | `mock` or `cdse` |
| `NEXT_PUBLIC_SITE_URL` | public | n/a | Canonical site URL used in email links. No trailing slash. |
| `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` | 🔒 | n/a | Copernicus OAuth client (required in `cdse` mode) |
| `CDSE_TOKEN_URL` / `CDSE_SH_BASE_URL` / `CDSE_WMTS_INSTANCE_ID` | server | CDSE defaults / unset | Overrides and legacy WMTS mode |
| `MAX_AOI_KM2` | server | `70000` | Reject larger areas before spending quota |
| `IMAGERY_CACHE_TTL_SECONDS` | server | `86400` | In-memory cache TTL |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_TILES_PER_MIN` | server | `30` / `240` | Per-IP limits |
| `DAILY_RENDER_BUDGET` | server | `3000` | Daily render cap per instance (`0` = off) |
| `TILE_CACHE_DIR` | server | unset | Disk tile cache (auto-off on Vercel) |
| `COMPARE_MAX_PX` / `COMPARE_RATE_LIMIT_PER_MIN` | server | `1500` / `6` | Analysis grid cap and analyze limit |
| `PER_ANALYSIS_PU_LIMIT` | server | `700` | PU cap per analysis, estimated before fetching (`0` = off) |
| `CHANGE_RULES` / `CHANGE_ENGINE` | server | `fused` / `v1` | Change-rule mode: `legacy`, `fused` or `ml`; `CHANGE_ENGINE` picks v1/v2 for `legacy` only |
| `S1_ENABLED` / `S1_WINDOW_DAYS` | server | `true` / `6` | Sentinel-1 GRD evidence for fused/ml rules and its ±day temporal median |
| `WORLDCOVER_ENABLED` | server | `true` | ESA WorldCover 2021 land-cover prior (free COG reads, no PU cost) |
| `SHARPEN_SWIR` | server | `false` | Opt-in regression sharpening of the 20 m SWIR bands (B11/B12) before index computation; changes NDBI/MNDWI/BSI, so it flips the compare cache key |
| `ML_MODEL_PATH` | server | `artifacts/ml/model.json` | Trained model for `CHANGE_RULES=ml` (missing → `CDSE_ML_MODEL_MISSING`) |
| `GEMINI_API_KEY` | 🔒 | unset | Enables the Summary tab |
| `GEMINI_MODEL` / `AI_SUMMARY_RATE_LIMIT_PER_MIN` | server | `gemini-2.5-flash` / `5` | Model (must be in the key's ListModels) and limit |
| `EMAIL_PROVIDER` | server | `console` | `console` (dev only), `smtp` or `resend` |
| `EMAIL_FROM` | server | n/a | `Rajasthan Imagery Explorer <address>`; must match the SMTP user / verified sender |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` | server | n/a | SMTP settings |
| `SMTP_PASS` / `RESEND_API_KEY` | 🔒 | n/a | Provider secret |
| `EMAIL_FIXED_RECIPIENT` | 🔒 | unset | Pins every report to one server-side address |
| `EMAIL_ALLOW_ANY_RECIPIENT` | server | `false` | Allow typed-address mode in production (leave off) |
| `EMAIL_DAILY_CAP` / `EMAIL_RATE_LIMIT_PER_ADDRESS_PER_DAY` / `EMAIL_RATE_LIMIT_PER_IP_PER_DAY` | server | `80` / `3` / `10` | Email quotas (UTC day, per instance) |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | server / 🔒 | unset | Optional CAPTCHA; set **both or neither** |
| `EMAIL_TEST_RECIPIENT` | dev | unset | Target for `npm run email:test` |
| `AUTH_REQUIRED` | server | `true` in prod / `false` in dev | Gate every route behind the session cookie (`""` = default) |
| `SESSION_SECRET` | 🔒 | n/a | HS256 secret, 32+ chars; required to sign/verify sessions; rotation signs everyone out |
| `SSO_USERS` | 🔒 | unset | JSON array of shared-credential users (build with `npm run auth:new-user`) |
| `GUEST_ENABLED` | server | `true` | Allow **Continue as guest** sessions |
| `SESSION_TTL_GUEST_HOURS` / `SESSION_TTL_SSO_HOURS` | server | `12` / `168` | Session lifetimes |
| `AUTH_GUEST_PER_IP_PER_HOUR` | server | `20` | Guest sessions per IP per hour |
| `ACCESS_REQUEST_PER_IP_PER_DAY` / `ACCESS_REQUEST_DAILY_CAP` | server | `3` / `10` | Access-request quotas (UTC day; cap `0` hides the form) |
| `SAVED_QUERIES_STORE` | server | `auto` | Saved-query storage: `auto` (Supabase when configured, else browser), `local`, or `supabase` (503 `SUPABASE_NOT_CONFIGURED` when unset) |
| `SUPABASE_URL` | server | unset | Supabase project URL for saved queries (server-only, never `NEXT_PUBLIC_*`) |
| `SUPABASE_SERVICE_ROLE_KEY` | 🔒 | unset | Service-role key that writes the `saved_queries` table; RLS has no public policies |

🔒 = secret. On Vercel mark secrets **Sensitive**, keep `NEXT_PUBLIC_*` as **Config** (Vercel refuses to hide public values), paste values **without quotes**, and redeploy after every change.

### Connect Copernicus (free)

1. Register at [dataspace.copernicus.eu](https://dataspace.copernicus.eu/).
2. Open the **Copernicus Data Space Dashboard** (<https://shapps.dataspace.copernicus.eu/dashboard/>) → User settings → **OAuth clients** → Create.
3. Copy the client ID and secret immediately (the secret is shown once) into `.env.local` and set `NEXT_PUBLIC_DATA_SOURCE=cdse`.
4. Restart and open `/api/health/cdse`. You want `{"status":"ok"}`.

> Create the client in the **Sentinel Hub dashboard**, not on the identity "Applications" page, or you will get `invalid_client` / 401.

**Quota:** renders are metered in processing units (PU). In our testing a tile is ~0.14 PU, a browsing session ~8 to 12 PU, a tehsil GeoTIFF ~2 to 3 PU, and a change analysis is 2 renders. Check your real monthly allowance in the dashboard. The app protects it with caching, a zoom band of 7 to 14, empty-tile short-circuits, `MAX_AOI_KM2`, rate limits and `DAILY_RENDER_BUDGET`.

---

## 🔍 Change Detection

Compare two Sentinel-2 dates over the selected district / tehsil / ILR. Every number comes from the deterministic raster pipeline in `lib/analysis/`; Gemini only phrases the results. Needs live data (`cdse`).

**Use it:** search an area → arm **Compare** in the scene strip → pick **A** and **B** on two scene cards (the server orders them so A is earlier) → **Analyze**. The results panel (right side on desktop, bottom sheet on mobile, resizable) has:

- **Swipe**: date A left, date B right on two synchronised maps — or switch the right side to the **Satellite basemap** (labelled as being from a different date).
- **Changes**: classified overlay, per-class toggles, opacity, *Boost visibility* (display-only), *Zoom to changes*, PNG / GeoTIFF export.
- **Stats**: totals, class table, per-tehsil table (click to highlight, optional shading), and a **Method & settings** card (resolution, valid data, scenes, sensitivity and minimum patch re-run, rules mode, SAR orbit/window, WorldCover prior, terrain mask, thresholds in collapsible sections), CSV export.
- **Events**: surviving change patches, largest first, with sub-labels (e.g. *likely harvest*), confidence tiers (0–100 %, default **Medium+** filter), numbered map markers and a themed popup; GeoJSON export.
- **Summary**: AI briefing (below).

Results are cached; if the cache has expired the server **recomputes from the analysis parameters**, so the tabs and exports keep working.

**Pipeline:** fetch NDVI / MNDWI / NDBI for each date (clouds, shadows and no-data masked) → classify with fixed precedence → 3×3 majority filter and a minimum mapping unit (0.2 ha) → statistics, per-tehsil zonal stats and events.

| Rule | Class |
| --- | --- |
| ΔMNDWI ≥ +0.20 and MNDWI(after) > 0 | Water gain |
| ΔMNDWI ≤ −0.20 and MNDWI(before) > 0 | Water loss |
| ΔNDVI ≤ −0.15 | Vegetation loss |
| ΔNDVI ≥ +0.15 | Vegetation gain |
| ΔNDBI ≥ +0.10 and ΔNDVI ≤ −0.05 | Bare / built-up increase |

Thresholds live in `lib/analysis/config.ts`; **sensitivity** scales them (low ×1.5, medium ×1, high ×0.7). They are heuristics: treat events as places to check, not confirmed changes. Valid data below 70% triggers a warning.

### 🧪 Evidence, rules & confidence

`CHANGE_RULES` (default **fused**) chooses the classifier:

- **legacy** — the shipped thresholds above (`CHANGE_ENGINE` picks v1 or v2).
- **fused** — every candidate patch is scored against up to three free evidence layers fetched alongside the optical run: a Sentinel-1 GRD water/roughness median (`S1_ENABLED`, ±`S1_WINDOW_DAYS` days, one orbit direction per side), the ESA WorldCover 2021 land-cover prior before date A (`WORLDCOVER_ENABLED`), and a Copernicus DEM hillshade-shadow mask. Patches get a 0–100 confidence (high ≥ 75, medium ≥ 55) and a sub-label such as *likely harvest* or *seasonal water loss*.
- **ml** — a softmax model trained on synthetic reference scenes over the same features: `npm run features` then `python ml/train.py` writes `artifacts/ml/model.json` (or `ML_MODEL_PATH`); without a model the API fails with `CDSE_ML_MODEL_MISSING`.

Confidence and sub-labels surface in the events list (default **Medium+** filter), the map popup, the **Method & settings** card (rules mode, SAR orbit and date window, WorldCover on/off, terrain mask), the email report and the AI summary. The evidence layers ride the existing CDSE and WorldCover endpoints — no new services, graceful fallback to optical-only when a layer is unavailable.

### 🤖 AI Summary (Gemini)

1. Create a free key in [Google AI Studio](https://aistudio.google.com/) → `GEMINI_API_KEY` (Sensitive on Vercel).
2. Check `/api/health/gemini`: you want `{"ok":true,"model":"…"}`. Without a key the Summary tab shows a setup hint.

The model narrates the computed numbers and must not invent places or causes. You choose whether to attach three small preview images (≤768 px); a failure with images offers **Try without images**. Output is schema-validated, cached and labelled AI-generated. Some Gemini models have very small free daily quotas, which is why the default is `gemini-2.5-flash`.

**Privacy:** the statistics and optional images of public Sentinel-2 data go to the Gemini API from the server; no user data is sent. Free-tier data terms differ from paid terms, so for sensitive deployments use a paid tier or leave the key unset.

---

## 🧭 Map inspector

One click on the map answers *what is here?* — a Google-Maps-style card on desktop, a bottom sheet on phones. Open it with a click / tap on the map, with the **Inspect map centre** control, or from the keyboard (focus *Inspect map centre*, press Enter); **Esc** closes it. Each click picks the richest hit: a numbered **change event** beats a **field parcel**, which beats an empty spot.

Sections appear only when they have something to say:

- **Location** — coordinates with **Copy coordinates**, reverse-geocoded place, district / tehsil / irrigation block, and **Select this tehsil** / **Select this district** buttons that arm the area filter.
- **Field** — when *Fields & crops* is loaded and a parcel is hit: area, confidence, cropping class and its 12-month NDVI sparkline, with a jump to the list row.
- **Change** — the analysis facts for the event under the pointer (or its loading / error state).
- **Imagery** — **Sample NDVI here**: one spot value with clear / cloudy conditions, against a daily quota.
- **Open elsewhere** — deep links to Copernicus Browser and Google Maps for the same location.

The inspector only reads what is already on the map — it never changes a selection on its own.

---

## 🌾 Fields & crops on the map

**SSO-only** (guests see the lock). The **Fields & crops** tab loads real field parcels from the [Fields of the World](https://fieldsoftheworld.org/) archive for Rajasthan — PMTiles and confidence COG reads happen **server-side**, the browser never fetches them — and colours them with a derived cropping pattern.

**Use it:** zoom to ≤ 25 km² → choose the **Agri year** (2024–25 / 2025–26 / 2026–27), **Analysis scope** (current view / selected tehsil) and **Min confidence** → **Load fields for scope** → **Run cropping pattern**.

- **Pattern** — 12 monthly NDVI composites per parcel classify it as *Fallow, Kharif only, Rabi only, Double-cropped, Zaid, Evergreen* or *Unclassified*, optionally with curve **groups** (**Group similar curves**), plus a processing-usage estimate (`est. … PU` against `PER_ANALYSIS_PU_LIMIT`).
- **Map** — parcels are painted from a fixed Okabe–Ito palette. **Colour parcels by** Pattern / Group / Confidence; **Parcel style** Fill + outline / Outline only. Legend chips isolate one class at a time (the list notes *Showing n of N fields*; **Show all** clears it); chips carry each class's count, area and share.
- **Charts** — *Mean NDVI by pattern* and *Mean NDVI by group* small multiples; the field list gives every parcel a sparkline with area, confidence, mean NDVI, peak month and valid months.
- **Inspector** — clicking a parcel opens the map inspector's **Field** section (see [Map inspector](#-map-inspector)); hovering a row highlights the parcel on the map.

**Honest limits:**

- The live archive publishes **2024–25 and 2025–26 boundaries only** for Rajasthan — **2026–27 loads 0 fields** and the panel says so (the year stays selectable so the notice is visible).
- **2026–27 is provisional**: rabi / zaid seasons have not finished, so fallow and kharif-only labels are withheld (shown as *Unclassified*).
- Classes come from 12 Sentinel-2 NDVI composites — heuristics to explore, not agronomic ground truth. Confidence (0–100) is sampled from the FTW confidence COG; when it is unavailable the panel shows *unavailable* and, at the default threshold, *No fields in this area at ≥ … confidence*.
- Selections are capped at **25 km²** (`FIELDS_MAX_KM2`), `FIELDS_MAX_COUNT` parcels per load and `PER_ANALYSIS_PU_LIMIT` for the PU pre-flight; built selections are cached server-side for a week. Attribution rides under the legend when confidence is available.

---

## 🛰️ High-resolution imagery (Bhoonidhi)

**SSO-only** (guests see the lock). The **High-resolution imagery** card in the layers panel shows [NRSC Bhoonidhi](https://bhoonidhi.nrsc.gov.in/) **LISS-IV** scenes (5.8 m, false colour) ingested for the selected area — India's national high-resolution data portal, from ResourceSat-2 / 2A.

**Use it:** select an area → open **Layers** → **High-resolution imagery** → pick a scene (acquisition date · sensor · resolution · covered area) → toggle it on with the eye button and set opacity. **Swipe vs Sentinel-2** splits the map: the nearest Sentinel-2 false-colour scene on the left, the high-resolution scene on the right, with a draggable divider (mouse, touch or arrow keys) and a date picker for the Sentinel-2 side. The card notes the scene's licence and *Source: NRSC / ISRO, via Bhoonidhi* under the map chip.

**How scenes get here:** a separate Python pipeline (`vhr/`, documented in [`vhr/README.md`](`vhr/README.md`), dispatched by `.github/workflows/vhr-ingest.yml`) authenticates against the Bhoonidhi API (20 tokens/hour/IP), clips each scene to the AOI + 200 m, applies a 2–98 percentile stretch and tiles it into a **private** Supabase Storage bucket (`vhr-tiles/<scene-id>/<z>/<x>/<y>.png`). The browser never talks to Bhoonidhi or Storage: `/api/vhr/scenes` lists what overlaps the bbox, and `/api/vhr/tiles/…` proxies one tile server-side after the `vhr.view` capability check — hits cache immutably, gaps answer a transparent pixel, and the service-role key never leaves the server.

**Requesting an area:** **Request high-resolution imagery for this area** emails the administrators the current selection as an `aoi.geojson` attachment (GeoJSON Feature with area name and requested date window) plus an *how to ingest this AOI* hint — use it when no scene exists yet. Availability mirrors the access-request gates (`EMAIL_FIXED_RECIPIENT` + `ACCESS_REQUEST_DAILY_CAP`, else the button reports the service is unavailable); abuse limits are shared with the access request (per IP / per requester / deployment per UTC day, plus 10-minute duplicate suppression). Nothing is stored.

> **Pending decision:** the on-map attribution wording is provisional pending NRSC guidance, and the Bhoonidhi licence terms should be confirmed with NRSC before wider distribution.

---

## 📧 Email Report

A button in the results panel header (**Send report to mail** in fixed mode, **Email report** in typed mode) sends one auto-generated email containing: the top events, statistics, optional AI summary, an inline change-map image, an `events.csv` attachment, and a **link that reopens the same analysis** (`?a=…&l=…&A=…&B=…&tab=events`). The email states that it is automatically generated by the Rajasthan Imagery Explorer website and must not be replied to.

**Setup (Gmail, free, fine for a few reports a day):**

1. On the sending Gmail account turn on 2-Step Verification and create an **App password** (use 16 characters, no spaces). Prefer a dedicated account.
2. Set `EMAIL_PROVIDER=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465` + `SMTP_SECURE=true` (or `587` + `false`), `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM="Rajasthan Imagery Explorer <same address as SMTP_USER>"`, `NEXT_PUBLIC_SITE_URL`.
3. Test with `npm run email:preview`, then `EMAIL_TEST_RECIPIENT=… npm run email:test`.

Other providers: `resend` (free tier; needs a verified domain to send to others) or any institutional SMTP relay using the same `SMTP_*` fields. `console` never sends and is refused in production.

**Recipient modes**

| Mode | How | Notes |
| --- | --- | --- |
| **Fixed recipient** (production) | `EMAIL_FIXED_RECIPIENT=address` | One-click confirm dialog with a masked hint (`m***@gmail.com`). The browser can never choose a recipient (a body with `email` is rejected). |
| **Typed address** | leave `EMAIL_FIXED_RECIPIENT` unset | Dev and demo. In production it is refused unless `EMAIL_ALLOW_ANY_RECIPIENT=true`. |

**Guard rails:** same-origin check, per-IP and daily quotas (`429` with the next reset time, 05:30 IST), honeypot, optional Turnstile (fail-closed), 10-minute duplicate suppression (no quota used), HTML ≤ 100 KB, CSV ≤ 1 MB, no CR/LF in the subject, addresses never logged (SHA-256 prefix only), nothing stored. If the AI summary fails the email still goes out without it.

**Abuse trade-off:** on a public site anyone can press the button until the daily cap is used. Turnstile, the per-IP limit, the cap and the duplicate guard bound it. Counters are in-memory per serverless instance (cold starts reset them); a durable store such as Upstash / Vercel KV is the upgrade path. Manual QA notes: `docs/email-qa.md`.

---

## 🔐 Authentication & access

Production runs behind a session gate (`middleware.ts`, Edge, jose-verified `rse_session` cookie — httpOnly, SameSite=Lax, Secure in production). Three states, read from `AUTH_REQUIRED` + `SESSION_SECRET`:

| State | Behaviour |
| --- | --- |
| **off** (`AUTH_REQUIRED=false`) | Everything is open; `/login` still works (dev default). |
| **ready** (gate on + valid secret) | Unauthenticated pages bounce to `/login?next=…`; unauthenticated APIs answer `401 UNAUTHENTICATED`; signed-in users opening `/login` are redirected home. |
| **misconfigured** (gate on, secret missing/short) | **Fails closed:** a plain "Authentication is not configured" page (503) for every app route; only `/api/health/*` and static files stay up. |

### Roles & capabilities

Exactly two roles exist — **guest** and **sso**. There is no admin/member tier: every SSO session holds full access. The role is a JWT claim only (`SSO_USERS` carries no role field). Policy lives in `lib/auth/permissions.ts` (single source); routes enforce it through `lib/auth/guard.ts`, the UI mirrors it from `GET /api/auth/session`, and the table below is generated from the same file.

<!-- BEGIN:capabilities -->
| Capability | Guest | SSO |
| --- | :-: | :-: |
| Scene search | ✅ | ✅ |
| View comparisons | ✅ | ✅ |
| Run comparisons | ✅ | ✅ |
| District-level compare | 🔒 | ✅ |
| Adjust sensitivity | 🔒 | ✅ |
| Adjust minimum patch | 🔒 | ✅ |
| PNG preview download | ✅ | ✅ |
| GeoTIFF download | 🔒 | ✅ |
| Copernicus Browser links | ✅ | ✅ |
| Change-map export (PNG/GeoTIFF) | 🔒 | ✅ |
| CSV export | 🔒 | ✅ |
| GeoJSON export | 🔒 | ✅ |
| Imagery GeoTIFF export | 🔒 | ✅ |
| AI summary | 🔒 | ✅ |
| Email report | 🔒 | ✅ |
| Fields / cropping pattern | 🔒 | ✅ |
| Map inspector | ✅ | ✅ |
| NDVI spot sample | ✅ | ✅ |
| Draw shapes | ✅ | ✅ |
| Analyze shapes | ✅ | ✅ |
| Save shapes | ✅ | ✅ |
| Shapefile download | 🔒 | ✅ |
| System status panel | 🔒 | ✅ |
| High-resolution imagery | 🔒 | ✅ |

**Guest limits:** 90-day window · tiles z≤12 · 30/day searches · 3/day analyses · 0/day AI · PNG ≤1024 px · 5 saved queries.

**SSO limits:** full archive · tiles z≤14 · 300/day searches · 50/day analyses · 30/day AI · PNG ≤2500 px · 50 saved queries.

🔒 = not available for that role (the API answers `403 FORBIDDEN_ROLE`; the UI shows a lock popover).
Daily quotas are counted per session **and** per client IP for each UTC day.
Generated from `lib/auth/permissions.ts` — run `npm run docs:permissions` after editing that file.
<!-- END:capabilities -->

**Sign-in options** on the landing page:

- **Sign in** — shared credentials from `SSO_USERS` (scrypt-hashed; verified with a dummy-hash path so timing cannot enumerate users; 5 failures / 15 min per IP *and* per username → `429` + `Retry-After`). Every bad password answers the same `401 INVALID_CREDENTIALS`.
- **Continue as guest** — a limited session (`guest:<uuid>` subject, `GUEST_ENABLED`, `AUTH_GUEST_PER_IP_PER_HOUR` quota). Guests get the guest column above: tighter search window, z≤12 tiles, tehsil/ILR compare only, default tuning, PNG ≤1024 px, no GeoTIFF / change-map export / AI / email / fields / system status.
- **Request access** — posts to `/api/access-request`; the admin mailbox (`EMAIL_FIXED_RECIPIENT`) receives a formatted table (name, company, Reply-To = requester, reason, IST time, request id) plus a **how to create this user** hint. Nothing is stored, nothing is auto-replied.

Locked UI controls show a padlock popover (Sign in / Request access); the API still returns the `403 FORBIDDEN_ROLE` contract if anything bypasses the UI.

**Granting access to someone:**

1. They fill the form on `/login`, or you add them directly.
2. Mint credentials: `npm run auth:new-user -- --username <name> --display "Full Name"` — the password is printed **once**, nothing is written to disk.
3. Add the printed JSON entry to `SSO_USERS` (one-line JSON array; Vercel → Environment Variables → mark **Sensitive**).
4. **Redeploy**, then send the person their username + password over a trusted channel.

> **This is shared-credential login, not federated SSO.** Everyone shares one `SSO_USERS` list with no per-user roles, MFA or password reset. The natural upgrade path is an identity provider (Keycloak / gov SSO / Supabase Auth) or per-user credentials with hashed passwords — the session cookie, middleware gate and login UI already sit in front of the app, so only `lib/auth/users.ts` + the login route would change.

**Sessions:** JWT (HS256) with `role`/`sub`/`name` claims; TTLs `SESSION_TTL_GUEST_HOURS` (12 h) and `SESSION_TTL_SSO_HOURS` (168 h = 7 days). **Rotating `SESSION_SECRET` signs everyone out.** The top-bar user menu shows *Guest* or the SSO display name with a role badge and **Sign out**; guests also get **Sign in with SSO**. Emailed deep links (`/?a=…&A=…&B=…&tab=events&e=…`) survive the bounce through a sanitised `next` parameter (same-origin relative paths only).

**Access-request limits** (independent of the report-email quotas): 3 / IP / UTC day, 2 / requester address / day (SHA-256 hashed), `ACCESS_REQUEST_DAILY_CAP` (10) shared across the deployment, 10-minute duplicate-content suppression (no quota), honeypot, optional Turnstile (fail-closed), and a friendly `503 ACCESS_UNAVAILABLE` when `EMAIL_FIXED_RECIPIENT` is unset or the cap is `0` — the UI hides the send button then. Logs only ever contain a hash prefix of the address.

**Env vars:** `AUTH_REQUIRED`, `SESSION_SECRET` 🔒, `SSO_USERS` 🔒, `GUEST_ENABLED`, `SESSION_TTL_*`, `AUTH_GUEST_PER_IP_PER_HOUR`, `ACCESS_REQUEST_*` — all documented in [Configuration](#-configuration). Generate the secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

**Windows note:** `npm run auth:hash -- <password>` — npm escapes spaces as `^` on Windows; prefer piping (`echo -n "pw" | npm run auth:hash`) or `auth:new-user` (which sanitises `^` out of `--display`).

---

## 🏠 Home, profile and preferences

The top bar ties the app together:

- **Home link** — the wordmark *Rajasthan Imagery Explorer* (top-left) returns to a clean home state: selections, scenes, compare results and in-flight requests are cleared, the preferred filters are re-applied, and the URL becomes `/`. Modified or middle clicks keep the browser's native open-in-new-tab behaviour.
- **Profile** (user menu) — identity, role, session issued/expires times (in your preferred time zone), today's binding quotas, and every capability with an available/locked chip. SSO sessions sign out here; guests get **Sign in with SSO** / **Request access**. Passwords are managed by the administrator, never in the dialog.
- **Preferences** (user menu) — six sections, **instantly applied, no Save button**: Appearance (theme, text size, reduced motion), Map defaults (basemap, composite, date range, cloud cover, overlay, visibility boost — applied at app start or Home), Units and format (area, coordinates, time zone, date format), Change detection and Reports (SSO-only; guests see the locked sections), and Data (Reset to defaults / Clear saved data).

Preferences are stored **per account, in this browser only** (`rie:prefs:v1:<subject>` — no secrets, never uploaded) and sync across open tabs. Unit and format choices change the interface only — statistics, exports and emails always use canonical hectares and UTC. Opening `/#profile` or `/#preferences` lands directly on that dialog; closing it clears the fragment.

---

## 📌 Saved queries

**Save** (in the Filters panel) captures the current search as a named query: the area (Rajasthan / district / tehsil / ILR), date range, cloud cap and composite — plus the compare tuning (sensitivity and minimum patch) for SSO. The **Saved queries** tab lists them with search, sorting, pinning, an **Add example queries** shortcut (four ready-made district searches) and export / import as JSON.

- **Run** re-applies everything in one click: rolling ranges (`last 90 days`) are recalculated from **today** at run time, the area selects, the stored compare tuning is restored (when unlocked), and `lastRunAt` / `runCount` are recorded.
- Each row's **⋯ menu** offers Run, Duplicate, Pin, Edit and Delete; deleting shows an **Undo** toast for 10 seconds. Names are unique per user — a clash answers `409 NAME_TAKEN` with a suggested free name. The panel header shows `n of N saved` for the current role's cap.
- **Export / import** moves queries between browsers as a single JSON file.

**Where they live** — `SAVED_QUERIES_STORE`:

| Mode | Behaviour |
| --- | --- |
| `auto` (default) | Supabase when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set, otherwise browser storage |
| `local` | Always this browser |
| `supabase` | Require Supabase — `503 SUPABASE_NOT_CONFIGURED` when the vars are missing |

- **Guests** are always browser-local (5 max) — clearing site data removes them; nothing leaves the device.
- **SSO** gets **50 per profile**, synced across devices when Supabase is configured (otherwise this browser).
- **Supabase setup:** create a project, run `supabase/migrations/20261115000000_saved_queries.sql` in the SQL editor, set the two env vars, redeploy. **RLS is on with no public policies** — only the server's service-role key reads or writes the table, so ids and names are never exposed to other users or the browser. Note that Supabase free tiers **pause after inactivity**: SSO saves then answer `503 STORAGE_UNAVAILABLE` until you resume the project, while guests (browser storage) are unaffected.

---

## ⚠️ Known Limitations

| Area | Limitation |
| --- | --- |
| **Resolution / plots** | 10 m pixels: plots well under ~0.1 ha are not resolved, and outlines follow pixels, not legal plot boundaries. District-level runs use a capped grid (`COMPARE_MAX_PX`); choose a tehsil for full detail. |
| **Built-up vs bare soil** | Spectrally similar in semi-arid terrain; the "bare / built-up" class can contain both. |
| **Crop cycles** | Harvest, tillage and irrigation look like change. Gaps under ~30 days show little; compare the same season across years. |
| **Single-date images** | Residual haze or shadow can create false change; composites are planned. |
| **Boundaries** | Census 2011: newer districts are missing and some tehsils are renamed. ILR data is a mock. |
| **Hosting** | No database: sessions, lockout counters, rate limits and quotas are per serverless instance (cold starts reset them); Vercel limits on duration, memory and response size apply. |
| **Saved queries** | Supabase free projects pause after inactivity — SSO saves answer `503 STORAGE_UNAVAILABLE` until the project resumes; guests keep working in browser storage. |
| **AI summary** | Can misread images; always check Stats and Changes. |
| **Fields & crops** | Boundaries come from the Fields of the World archive: Rajasthan publishes 2024–25 and 2025–26 only, so 2026–27 loads 0 parcels (the panel says so) and its classes are provisional (fallow / kharif withheld → *Unclassified*). Pattern classes are NDVI heuristics, not agronomic truth. Selections ≤ 25 km² with parcel-count and PU caps. |
| **High-resolution imagery** | Scenes exist only where the `vhr/` pipeline has ingested them (AOI ≤ 400 km², Bhoonidhi API quota of 20 tokens/hour); otherwise the card says *No high-resolution scenes for this area yet*. Ingestion runs outside Vercel (dispatch workflow) and needs GDAL, which tests never import. Attribution wording and licence confirmation with NRSC are pending. |

---

## ▲ Deploy to Vercel

1. Import the repo (Next.js is auto-detected).
2. Add the variables from [Configuration](#-configuration). Use **Production** scope for the email variables so preview deployments cannot send mail. Mark `SESSION_SECRET`, `SSO_USERS`, `SMTP_PASS`, `RESEND_API_KEY`, `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and the CDSE keys **Sensitive**. Leave `TILE_CACHE_DIR` and `CDSE_WMTS_INSTANCE_ID` unset. Saved queries need no database config by default (`SAVED_QUERIES_STORE=auto` falls back to browser storage) — add `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` only for cross-device SSO queries.
3. `vercel.json` pins the region to `fra1` (close to Copernicus); route `maxDuration` is 60 s for renders and analysis.
4. **Redeploy** after any env change (and untick the build cache when env values changed).

> **Large downloads:** Vercel caps buffered responses at ~4.5 MB, but streamed responses are exempt, so `/api/imagery` always streams (chunked).
> **Plans:** the Hobby plan is for personal, non-commercial use; check Vercel's terms for client deployments.
> **Merging to `main` deploys to production.** Keep CI green, and consider a branch-protection rule requiring it.

**Self-hosting / government servers:** it is a standard Node 20+ app (`npm run build && npm start`) with no database. Allow-list the outbound hosts in [Architecture](#-architecture), provide an SMTP relay for email, and decide whether to enable Gemini (it can be left off). Use `EMAIL_FIXED_RECIPIENT` and keep `EMAIL_ALLOW_ANY_RECIPIENT` unset.

### ✅ Release checklist

- [ ] `/api/health/cdse` and `/api/health/gemini` return ok; `/api/compare/email/config` shows `"enabled": true`
- [ ] Search a district → select a scene → imagery clipped to the shape; zoom to ~13 and it sharpens
- [ ] True / False colour / NDVI switch (NDVI legend appears); calendar highlights scene dates
- [ ] Downloads: PNG, visual GeoTIFF, analysis GeoTIFF (open in QGIS), Copernicus Browser link
- [ ] Compare two dates weeks apart: Swipe (dates **and** Satellite basemap modes), Changes, Stats, Events, Summary all work; hovering and clicking events highlights and zooms
- [ ] **Send report to mail**: the email arrives (check spam), its links reopen the analysis, Gmail "Show original" shows SPF / DKIM / DMARC PASS
- [ ] **Gate**: signed out → `/login` (with `?next=` preserved); sign in, guest, sign out all work; emailed deep link lands on the right analysis after login; a bad password always says *Invalid username or password*
- [ ] **Saved queries**: save → Run re-applies area/dates/cloud after a reload (rolling ranges recalc from today); duplicate, pin, edit, delete + Undo work; export → import round-trips; guest stops at 5 with an inline error
- [ ] Light / dark with the panel open; panel width 360 to 560 px with no overlapping text
- [ ] No console or CSP errors; no browser calls to `sh.dataspace.copernicus.eu`; secrets absent from page sources
- [ ] Sentinel Hub dashboard usage looks sane after a session

---

## 🛡️ Security

| Area | Protection |
| --- | --- |
| **Secrets** | Server-only vars are validated by zod and never imported into client code; the production bundle is scanned for credentials. If one leaks, rotate it (Sentinel Hub dashboard, Google AI Studio, Google app passwords). |
| **Headers** | CSP (allow-lists only self, OpenFreeMap, Esri, Nominatim, Cloudflare Turnstile), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, HSTS. |
| **API** | zod validation on every route, 512 KB body cap, same-origin check on POST (`403 CROSS_ORIGIN`), `{ code, message }` errors without upstream details. |
| **Quota & abuse** | Per-IP rate limits (API, tiles, compare, AI, email), daily render budget, upstream timeouts, email guard rails above. |
| **Sessions & gate** | httpOnly/SameSite=Lax cookie, HS256 via `jose`, scrypt (N=16384) password hashes with a dummy-hash timing path, uniform `401 INVALID_CREDENTIALS`, lockout (5 / 15 min per IP + username), fail-closed 503 when the gate is on without a usable secret, sanitised `next` redirects, no subject/secret in API responses. |
| **AI** | Gemini key is server-only; the summary uses server-side analysis data only; model output is validated and rendered as plain text. |

`npm audit` advisories that need major upgrades (Next 16 / MapLibre 6 / Tailwind 4) are not reachable at runtime here; re-evaluate on the next major upgrade.

---

## 🧪 Testing & CI

Run `npm run verify` before pushing: typecheck → lint → unit tests → production build, **zero errors** (unused variables are lint errors and also fail the Vercel build). CI (`.github/workflows/ci.yml`) runs it on every push and PR to `main` with the mock data source and no secrets, then boots the production server and smoke-tests `/` and `/api/health/cdse`. The `vhr` job installs GDAL-free Python deps and runs the Bhoonidhi ingest pipeline's pytest suite (`python -m pytest vhr`) — it needs no credentials and never contacts the network. Work on a feature branch, open a PR, wait for green CI, then merge.

---

## 🗂️ Project Layout

```text
app/api/            scenes · imagery · tiles/[z]/[x]/[y] · compare (analyze, overlay, summary, email, email/config) · auth (login, guest, logout, session) · access-request · vhr (scenes, tiles, request) · health (cdse, gemini)
app/login/          landing page (hero + auth card, page-level CSS)
components/         shell · filters · layers · map · scenes · compare (tabs, EmailReport, ShareLinkLoader) · login (LoginHero, AuthCard) · ui
data/               boundaries/ (OSM districts · Census tehsils) · mock/
docs/               screenshots/ · email-qa.md
experiments/        standalone research (super-resolution; not part of the app build)
lib/auth/           config, session (jose), passwords (scrypt), users (SSO_USERS), limits (lockout/guest), nextPath
lib/cdse/           OAuth, STAC, Process API, evalscripts, tiling maths
lib/analysis/       change-detection engine (config, classify, filter, stats, encoders)
lib/compare/        client helpers: stream, map bridge, share links, exports
lib/email/          providers (smtp, resend, console), templates, quotas
lib/vhr/            shared VHR scene types (app side of the Bhoonidhi pipeline)
lib/server/         API helpers, area resolution, budgets, Gemini client, Turnstile, access-request quotas
lib/data/           DataAdapter + mock/cdse adapters, boundaries
store/              Zustand stores (app, compare, session)
scripts/            mock data, boundary fetchers, email tools, auth CLIs, tests
vhr/                Bhoonidhi ingest pipeline (Python + GDAL; runs outside Vercel, see vhr/README.md)
middleware.ts       Edge access gate (public paths, 401s, /login?next=)
```

---

## 🎨 Design Tokens

CSS variables in `app/globals.css`, mirrored in `tailwind.config.ts`; dark theme via `<html data-theme="dark">`. Map layers cannot read CSS variables, so their colours are mirrored in `lib/map/palette.ts`.

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` / `--surface` | `#F6F5F1` / `#FFFFFF` | `#14151A` / `#1C1E24` |
| `--text` / `--text-muted` | `#1B1D22` / `#6B6E76` | `#E8E6E1` / `#9A9DA6` |
| `--border` | `#DAD7CF` | `#2E323B` |
| `--accent` (terracotta) | `#C2410C` | `#F0713A` |

Public Sans for UI, IBM Plex Mono (tabular numerals) for coordinates, dates and ids; 6 px / 8 px radii, hairline borders. **Change the accent** by editing `--accent`, `--accent-soft`, `--accent-fg` (light and dark) in `globals.css` and `MAP_PALETTES` in `lib/map/palette.ts`.

---

## 🧭 Data & Extensibility

**Boundaries:** the current 41 districts (28–30 Dec 2024 reorganisation) come from [OpenStreetMap](https://www.openstreetmap.org) (ODbL, Overpass `admin_level=5` relations) and the 224 tehsils are the [Datameet](https://datameet.org) Census-2011 taluk boundaries, re-parented to the new district layout. Refresh with `npx tsx scripts/fetch-districts-41.ts` (writes `data/boundaries/*.geojson`, rings normalised to counter-clockwise; clockwise exterior rings render empty in Sentinel Hub) and check with `npm run validate:boundaries` (41 features, exact names, gaps/overlaps, area within ±2% of 342,000 km², legacy deltas). District geometry © OpenStreetMap contributors (ODbL); tehsil geometry © Datameet / Census 2011 (see `data/boundaries/README.md`). **Government/administrative use:** these are community-mapped and Census-era boundaries — cross-check against Survey of India / Rajasthan DoITC (RajDhara) products before relying on them officially. ILR comes from `data/mock/ilrs.geojson` until real data arrives. To use client data, replace the GeoJSON (`id`, `name`, `parentId`, Polygon/MultiPolygon in EPSG:4326) or implement a new adapter.

**DataAdapter:** all data access goes through one interface (`lib/data/adapter.ts`); swap the singleton in `lib/data/index.ts` to add PostGIS, Supabase or another STAC.

```ts
interface DataAdapter {
  getDistricts(): Promise<District[]>;
  getTehsils(districtId: string): Promise<Tehsil[]>;
  getIlrs(tehsilId: string): Promise<Ilr[]>;
  searchScenes(params: SearchParams): Promise<Scene[]>;
}
```

---

## 🗺️ Roadmap

- **Draw tool** (planned): draw a polygon or rectangle, name it with a note, run imagery and change detection on it, and export it as GeoJSON / Shapefile.
- **Change Engine v2** (planned): multi-observation composites, radiometric normalisation, adaptive thresholds, plot-level objects (parcel mode when cadastral polygons exist), smoother sub-pixel edges, full-coverage block processing, per-event confidence scores and a validation harness.
- **Automatic alerts:** notify when new change events appear (email reports are manual today).
- **Real ILR / parcel boundaries** and current (post-reorganisation) tehsil boundaries.
- **Persistent cache and per-user quotas;** a durable rate limiter (Upstash / Vercel KV), and a proper identity provider (per-user accounts, MFA, password reset) instead of shared credentials.
- **Swipe fidelity:** raw, unfiltered imagery with the earlier date always on the left.
- Time-lapse and multi-date comparison.

---

## 🩺 Troubleshooting

| Symptom | Code | Fix |
| --- | --- | --- |
| Requests rejected | `RATE_LIMITED` / `DAILY_BUDGET_EXCEEDED` | Wait for `Retry-After` or raise `RATE_LIMIT_PER_MIN` / `DAILY_RENDER_BUDGET` |
| "Area too large" | `AOI_TOO_LARGE` | Pick a tehsil / ILR or raise `MAX_AOI_KM2` |
| Download rejected | `DOWNLOAD_TOO_LARGE` | Over 2500 px: pick a smaller area or accept the reduced resolution |
| Everything 500s in `cdse` mode | `CDSE_CONFIG` | Set `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` |
| Auth failures (`invalid_client`) | `CDSE_AUTH` / 401 | Recreate the OAuth client (**Data Space Dashboard > User settings > OAuth clients**); check whitespace/quotes; token URL and API base must match |
| Search 403 *Invalid or expired account* | `CDSE_AUTH` / 403 | The token works — the **account has no active plan/trial**: renew/activate it in the Data Space Dashboard, then retry (no env changes needed) |
| Upstream errors | `UPSTREAM_ERROR` (502) | Copernicus outage or timeout: retry |
| Renders empty / imagery never appears | n/a | Polygon winding must be counter-clockwise (re-run `npx tsx scripts/fetch-districts-41.ts`) |
| Tiles blank for a date | n/a | No acquisition covers that tile on that day: pick another date |
| GeoTIFF looks black | n/a | The **analysis** GeoTIFF holds raw reflectance (0 to ~1): stretch it in GIS software, or use **GeoTIFF (visual)** |
| No scene on a date | `COMPARE_NO_SCENE` | Pick another date |
| Export fails later | `OVERLAY_NOT_FOUND` | Cache aged out: re-run the analysis |
| AI summary issues | `AI_DISABLED` / `AI_AUTH` / `AI_MODEL_NOT_FOUND` / `AI_RATE_LIMITED` / `AI_BAD_REQUEST` / `AI_BAD_OUTPUT` / `AI_UNAVAILABLE` | Add or replace the key; fix `GEMINI_MODEL`; wait out the quota; use **Try without images**; **Retry**. `/api/health/gemini` shows the same code |
| **Send report button missing** | n/a | Open `/api/compare/email/config` on the site and read `reason`. Usual causes: `NEXT_PUBLIC_SITE_URL` missing (or saved as Secret / with quotes), `EMAIL_PROVIDER` unset or `console`, `EMAIL_FIXED_RECIPIENT` not set for Production, only one Turnstile key set, or no redeploy after adding variables |
| Email errors | `EMAIL_DISABLED` / `EMAIL_RATE_LIMITED` / `EMAIL_CAPTCHA_FAILED` / `EMAIL_SEND_FAILED` | Configure the provider; wait for the stated reset (05:30 IST); check Turnstile keys; check the SMTP credentials |
| SMTP authentication failed | n/a | Use a fresh 16-character app password (no spaces) with 2-Step Verification on; `EMAIL_FROM` must use the same address as `SMTP_USER` |
| `npm run email:test` sends to the wrong address | n/a | A shell variable overrides `.env.local`: clear it (PowerShell `Remove-Item Env:EMAIL_TEST_RECIPIENT`) |
| Locked out of the dashboard | `AUTH_RATE_LIMITED` | Wait for the countdown (5 failures / 15 min per IP + username); counters are per instance, so a cold start also clears them. As an admin, reset the username counter only by redeploying — or wait it out |
| "Authentication is not configured" (plain 503 page) | `AUTH_NOT_CONFIGURED` | `AUTH_REQUIRED=true` but `SESSION_SECRET` is missing/short (<32 chars) — the gate fails closed by design. Set the secret (Vercel → **Sensitive**) and redeploy |
| Redirect loop between `/` and `/login` | n/a | Almost always a cookie that cannot stick: run over http (localhost is fine), check no proxy strips `Set-Cookie`, and confirm `SESSION_SECRET` is identical across deployments. `AUTH_REQUIRED=false` bypasses the gate for debugging |
| Emailed report link asks to sign in | n/a | Expected when the gate is on: the link bounces through `/login?next=…` and resumes the deep link after login (session must still be valid) |
| Sign-in always says *Invalid username or password* | `INVALID_CREDENTIALS` | The entry in `SSO_USERS` must be a fresh `auth:new-user` hash (old `scrypt$` formats with different params fail closed) and the username is case-insensitive; check for a stray space in the JSON |
| "Access requests are unavailable right now" | `ACCESS_UNAVAILABLE` | Set `EMAIL_FIXED_RECIPIENT` (and keep `ACCESS_REQUEST_DAILY_CAP` > 0); the request form hides itself until then |
| Turnstile enabled but the widget never appears | n/a | Set **both** `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` — with only the secret the server rejects every attempt and the login page cannot render the challenge |
| Vercel build fails at "Linting" | n/a | Run `npm run verify`; unused variables are lint errors |
| `EADDRINUSE` on dev | n/a | Free port 3000 or run `npm run dev -- -p 3001` |
| PowerShell breaks `curl` JSON | n/a | Use the browser, Postman or a Node script for POST tests |

---

## 📜 Attribution & Data Sources

- **Sentinel-2:** contains modified Copernicus Sentinel data, © ESA / Copernicus, via the [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/) (Copernicus licence terms apply; keep the attribution).
- **Basemaps:** [OpenFreeMap](https://openfreemap.org/) (OpenMapTiles, © OpenStreetMap contributors, ODbL) and Esri World Imagery (Esri, Maxar, Earthstar Geographics; check Esri's terms for commercial use). **Geocoding:** [Nominatim](https://nominatim.org/), © OpenStreetMap contributors.
- **Boundaries:** districts © [OpenStreetMap](https://www.openstreetmap.org) contributors (ODbL-1.0, via Overpass); tehsils © [Datameet](https://datameet.org) Census 2011 compilations (Census of India open data, upstream has no explicit licence file). **Field parcels & confidence:** [Fields of the World](https://fieldsoftheworld.org/) (CC BY 4.0 — Robinson et al. 2026, via data.source.coop).
- **High-resolution imagery:** NRSC Bhoonidhi scenes (ResourceSat-2 / 2A LISS-IV, 5.8 m) — *Source: NRSC / ISRO, via Bhoonidhi*; licence terms pending confirmation with NRSC.
- **AI:** Google Gemini API (optional). **Libraries:** MapLibre GL JS, Next.js, zod, turf, Radix UI, Nodemailer, lucide; fonts Public Sans and IBM Plex Mono (SIL OFL).

---

## 👤 Author

**Vatsal Mishra**, Full-stack + Applied AI Engineer · [GitHub @Vatxsal](https://github.com/Vatxsal) · [LinkedIn](https://www.linkedin.com/in/vatsal-mishra-08614a198/)

Released under the [MIT License](LICENSE) © Vatsal Mishra

<div align="center"><sub>Built with Next.js, MapLibre and Copernicus Sentinel-2 data · Made for Rajasthan 🇮🇳</sub></div>
