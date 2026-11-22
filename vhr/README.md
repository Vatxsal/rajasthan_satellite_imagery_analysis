# High-resolution imagery ingest (NRSC Bhoonidhi)

Python pipeline that turns online [Bhoonidhi](https://bhoonidhi.nrsc.gov.in/)
deliveries into private XYZ tile pyramids in Supabase Storage, ready for the
Next.js app to serve through its authenticated tile route. Nothing here runs on
Vercel — GDAL does the heavy lifting in Docker or in a GitHub Actions job.

## What it does

1. **search** — POST `/data/search` (STAC) for an AOI + date range, filter
   `Online = Y`, and print a markdown candidate table (item id, date, AOI
   coverage %, online flag). No download, no upload.
2. **ingest** — download the delivery (zip or GeoTIFF), clip to the AOI
   buffered by 200 m, reproject to EPSG:3857, apply a per-band 2–98 percentile
   stretch inside the AOI, write an 8-bit RGBA GeoTIFF (transparent outside the
   clip), generate XYZ PNG tiles, then upload tiles to the private
   `vhr-tiles` bucket and insert a `public.vhr_scenes` row.
3. **local-file** — same processing for a delivery you already have (Cartosat
   and other products that are ordered through the portal's Browse & Order and
   are not directly downloadable via the API).

## Band mapping

| Source bands | Default output |
| --- | --- |
| 3 (green, red, NIR) | false colour: R = NIR, G = red, B = green |
| 1 | grayscale (replicated to RGB) |
| 2 or 4+ | rejected — pass an explicit `--bands R,G,B` (e.g. `--bands 4,3,2`) |

Separate per-band GeoTIFFs are ordered `green`, `red`, `nir` by file name
(numeric fallback with a warning).

## Secrets (environment only, never printed, never on the command line)

| Variable | Used by |
| --- | --- |
| `BHOONIDHI_USER`, `BHOONIDHI_PASSWORD` | token grant for search/download |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | tile upload + `vhr_scenes` insert |

Bhoonidhi limits worth respecting (the client enforces them):

- **20 tokens/hour/IP** — one password grant per run, then refresh; logout
  always runs on close (403 "maximum sessions" otherwise).
- **3 search requests/second** — throttled in the client.
- **≤3 concurrent downloads** — strictly sequential here.
- Transient 429/5xx and download 412/504 wait through a long exponential
  backoff; 401/403/429 on the token endpoint raise immediately (operator
  action, not a retry).

## Running via GitHub Actions (recommended)

Workflow: `.github/workflows/vhr-ingest.yml` (manual dispatch only, never on
push). Required repository secrets: `BHOONIDHI_USER`, `BHOONIDHI_PASSWORD`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

1. **Dispatch with `mode = search`**, paste the AOI GeoJSON, set
   `start_date` / `end_date` (and optionally `collection`). Read the candidate
   table in the job summary.
2. **Dispatch again with `mode = ingest`**, same AOI, plus `item_id` and
   `collection` for the scene you picked (or leave `item_id` empty to ingest
   the best automatically-ranked candidate for the date range).

AOI guard: anything over **400 km²** is rejected; scenes are refused above
**3000 tiles**.

## Running locally with Docker

```sh
docker build -t rse-vhr vhr

# 1. search
docker run --rm \
  -e BHOONIDHI_USER -e BHOONIDHI_PASSWORD \
  -v "$PWD:/work" -w /work rse-vhr \
  search --aoi aoi.geojson --start 2024-01-01 --end 2024-01-31

# 2. ingest an online scene
docker run --rm \
  -e BHOONIDHI_USER -e BHOONIDHI_PASSWORD \
  -e SUPABASE_URL -e SUPABASE_SERVICE_ROLE_KEY \
  -v "$PWD:/work" -w /work rse-vhr \
  ingest --aoi aoi.geojson --start 2024-01-01 --end 2024-01-31

# local-file: an order you downloaded from the portal (Cartosat etc.)
docker run --rm \
  -e SUPABASE_URL -e SUPABASE_SERVICE_ROLE_KEY \
  -v "$PWD:/work" -w /work rse-vhr \
  local-file --file cartosat_order.zip --aoi aoi.geojson \
    --collection CartoSat-1_PAN_CartoDEM_30m --item-id YOUR-ORDER-ID \
    --date 2024-05-01 --resolution-m 2.5
```

Useful flags on every subcommand: `--bands 4,3,2`, `--resolution-m 5.8`,
`--work-dir DIR`, `--dry-run` (tile everything but skip the upload/insert).

GDAL comes from the image (`gdal-bin`, `python3-gdal`, `python3-numpy`); the
host needs nothing but Docker. Without GDAL the pure helpers still run — only
the processing functions refuse to start.

## Storage layout & sizing

- Private bucket `vhr-tiles`: `<scene-uuid>/<z>/<x>/<y>.png` (+ optional
  `<scene-uuid>/quicklook.jpg`).
- `public.vhr_scenes` row: sensor/date/resolution, band mapping, stretch
  percentiles, bbox + footprint, zoom range, tile count, size, licence note.
- Sizing: a 400 km² AOI at 5.8 m produces **tens of MB** of PNGs (thousands
  of tiles) — the 3000-tile ceiling keeps a single scene well under ~150 MB.

## Licensing

NRSC/ISRO imagery is released under government-entity terms. The stored
`license_note` and the app's attribution ("Source: NRSC / ISRO, via
Bhoonidhi") must be confirmed with NRSC before any public display; do not
redistribute raw deliveries.

## Tests

```sh
pip install -r vhr/requirements.txt pytest
pytest vhr -q
```

Unit tests cover the API client (token reuse/refresh/logout, throttling,
pagination, WAIT backoff), the pure pipeline helpers (AOI area guard, band
mapping, zoom math, tile ceiling, coverage), the storage writer and the CLI
surface. GDAL is never imported by the tests, so they run anywhere.
