# Change Engine — Audit & Baseline (v1)

Audit of the compare/change-detection pipeline as of `4ef1f47` (branch `feat/change-engine-v2`).
All references are `file:line`. Companion document: `validation/README.md` (labeling harness).

---

## 1. Pipeline overview

```
POST /api/compare/analyze
 ├─ guards: sameOrigin, rate limit (COMPARE_RATE_LIMIT_PER_MIN=6), zod body
 ├─ resolveArea(level, areaId) → bbox; MAX_AOI_KM2=70000 gate
 ├─ STAC search both dates (maxCloud: 100 → no cloud filtering, limit 50)     route.ts:129-148
 ├─ grid: computeOutputSize(bbox, COMPARE_MAX_PX=1500 long side)              analyze.ts:74
 ├─ fetch A: 1 Process POST (whole bbox, FLOAT32, 5 bands)  fetch.ts:30-66
 ├─ fetch B: same
 ├─ parse GeoTIFF (geotiff.js)                          parse.ts:21-48
 ├─ inside-mask (pixel-centre even-odd fill)            mask.ts:31-78
 ├─ validity = both dates valid + 1 px invalidity halo  classify.ts:12-46
 ├─ classify per pixel (hard thresholds)                classify.ts:52-84
 ├─ majority filter 3×3 (1 pass)                        filter.ts:14-53
 ├─ MMU: 8-conn components < 0.2 ha → no_change         filter.ts:74-125
 ├─ computeStats + hotspots (top-10 by pixel count)     stats.ts:36-243
 ├─ overlay PNG (class→RGBA) + gz class raster          analyze.ts:160-161
 └─ NDJSON stream {stage…}{result} → store → drawer/map
```

Client: `lib/compare/run.ts` → `store/useCompareStore.ts` → recolor blob overlay
(`lib/compare/recolor.ts`) + map layers/markers (`lib/compare/bridge.ts`) → drawer tabs
(`components/compare/*`).

---

## 2. Bands & indices (current, v1)

**Evalscript** (`lib/analysis/evalscript.ts`): Sentinel Hub v3, `sentinel-2-l2a`,
`mosaicking: "ORBIT"`, `timeRange` = one UTC day, `mosaickingOrder: "mostRecent"`.

- Inputs: `B03, B04, B08, B11, SCL, dataMask` (`evalscript.ts:16`).
- Outputs (FLOAT32): `NDVI, MNDWI, NDBI, VALID, dataMask` (`evalscript.ts:6,14-19`).
- Formulas (`evalscript.ts:32-37`): NDVI=(B08−B04)/(B08+B04); MNDWI=(B03−B11)/(B03+B11);
  NDBI=(B11−B08)/(B11+B08); denom 0 → 0.
- `VALID = SCL ∉ {0,1,3,8,9,10,11}` evaluated only where `dataMask===1` (`evalscript.ts:21-31`).
  Nodata → all bands 0, VALID=0.
- **No median/multi-temporal mosaic exists**: one acquisition per side, first-valid-sample
  selection only (`evalscripts.ts:30-35`, `fetch.ts:47-51`). No B02/B05/B12, no AWEI/BSI/
  brightness/NDWI(Shi)/NDBI-safe, no cloud-probability (CLD) band, no `valid_obs_count`.
- Resampling: single `processing.upsampling/downsampling = "BILINEAR"` for the whole request
  (`fetch.ts:53`) — applies to categorical SCL (20 m native) as well as reflectance.
- Grid: long side pinned to `COMPARE_MAX_PX` (default **1500**, env `lib/env.ts:30`);
  `metadata.coarse = metersPerPixel > 10` (`analyze.ts:145`). Most districts therefore run
  coarser than 10 m in a single shot.

---

## 3. Thresholds (current, v1)

`lib/analysis/config.ts:51-62`, scaled by sensitivity ×1.5 (low) / ×1 (medium) / ×0.7 (high)
(`config.ts:37-41,75-86`):

| Threshold | Medium value | Meaning | Class |
|---|---|---|---|
| `waterGain.dMndwi` | +0.20 | ΔMNDWI ≥ t AND MNDWI(B) > 0 | water_gain |
| `waterLoss.dMndwi` | −0.20 | ΔMNDWI ≤ t AND MNDWI(A) > 0 | water_loss |
| `vegLoss.dNdvi` | −0.15 | ΔNDVI ≤ t | veg_loss |
| `vegGain.dNdvi` | +0.15 | ΔNDVI ≥ t | veg_gain |
| `bareBuilt.dNdbi` | +0.10 | ΔNDBI ≥ t | builtup/bare |
| `bareBuilt.dNdviMax` | −0.05 | AND ΔNDVI ≤ t | builtup/bare |
| `bareBuilt.maxMndwi` | 0.10 | AND MNDWI(A,B) ≤ t | builtup/bare |

- Decision order (first wins): `outside → masked → waterGain → waterLoss → vegLoss → vegGain
  → bareBuilt → no_change` (`classify.ts:60-83`).
- **Consequence**: vegLoss at −0.15 fires before bareBuilt's own ΔNDVI ≤ −0.05 gate, so
  built-up can only occur in the band −0.15 < ΔNDVI ≤ −0.05 (medium) (`classify.ts:72,77`).
- Geometry/denoise: `DEFAULT_MIN_PATCH_HA = 0.2` (config.ts:46), `MAJORITY_WINDOW = 3`
  (config.ts:48), invalidity halo = 1 output px (`classify.ts:29-46`), catalog `maxCloud=100`
  (`route.ts:133,143`), UI low-valid banner `< 70%` (hard-coded, `CompareStatsTab.tsx:95`).
- **Dead config**: `waterGain.mndwiAfter` / `waterLoss.mndwiBefore` are declared but never read
  (literal `> 0` hard-coded at `classify.ts:68,70`); `bareBuiltMaxMndwi` is applied but not
  echoed into `metadata.thresholds` (`analyze.ts:148-155`).
- Rationale block itself says "These are heuristics, not physics" (`config.ts:24`). No date-gap
  rule: Jan-vs-Oct passes the same thresholds (only `dateA !== dateB` is validated).

---

## 4. Filters (pixel level)

| # | Filter | Where |
|---|---|---|
| 1 | SCL exclusion {0,1,3,8,9,10,11} server-side | `evalscript.ts:21-27` |
| 2 | dataMask nodata → 0-fill | `evalscript.ts:31,41` |
| 3 | valid = validBand≥0.5 && dataMask≥0.5 per date | `parse.ts:42-45` |
| 4 | valid = A && B && inside | `classify.ts:12-22` |
| 5 | 1-px invalidity halo (no cascading) | `classify.ts:29-46` |
| 6 | AOI fill, pixel-centre even-odd (all-in/all-out edges) | `mask.ts:31-78` |
| 7 | Majority 3×3, 1 non-iterated pass, raster-order ties | `filter.ts:14-53` |
| 8 | MMU: 8-conn components (change codes only) < minPatchPx → no_change | `filter.ts:74-125` |

Not present: scene cloud gate, SCL 2 (cast shadow) / 7 (unclassified) exclusion, adjacency
correction, water guard on vegetation classes, valid-% quality gate (UI banner only).

---

## 5. Resolution, cost & budget guard

- **There is no PU cost model today.** Cost is counted in whole Process renders:
  `consumeRenderBudget()` (`lib/server/budget.ts:15-33`) before each render
  (`fetch.ts:28`, `process.ts:51,135`); `DAILY_RENDER_BUDGET` default **3000**/UTC-day per
  instance (`lib/env.ts:28`), `0` disables. One analysis = **2 renders** (A + B), documented at
  `lib/env.ts:31`. No `PER_ANALYSIS_PU_LIMIT` exists yet (Phase 5 introduces it).
- Per-IP: `COMPARE_RATE_LIMIT_PER_MIN = 6` (`lib/env.ts:30`), body cap 512 kB, AOI ≤ 70 000 km²,
  grid ≤ `COMPARE_MAX_PX`, route `maxDuration = 60` (`route.ts:19`).
- **Official PU formula (verified Phase 1, source: CDSE "Processing Unit" docs +
  Sentinel Hub FAQ "How many processing units do I need")**:

  ```
  PU = (W×H / 512², min 0.01)
     × (input bands / 3, dataMask not counted)
     × (2 if 32-bit float TIFF, else 1)
     × (data samples per pixel)
     × (orthorectification ×2, data-fusion, … surcharges)
  min cost per Process request = 0.005 PU
  ```

  "Data samples per pixel" = the samples delivered to `evaluatePixel`: **one per
  orbit/time-slice in the `timeRange`** (batch docs: "number of data samples = no. of
  observations available in the requested time range"; FAQ Example 2 shows ×500 for a
  500-scene script; the CDSE PU-calculator article shows 26 ORBIT images → 886 PU).
  **Correction of the Phase 0 draft**: composite requests do NOT cost the same as
  single-date — PU scales **linearly with the number of orbits inside the window**
  (a `SIMPLE` mosaic would collapse to 1 sample, but it keeps only one scene per pixel,
  i.e. no temporal median, so we do not use it).
- **Worked numbers** (grid cap `COMPARE_MAX_PX = 1500` → max size factor
  1500²/262144 ≈ **8.58**; both engines FLOAT32 TIFF ×2):
  - v1 single date (1 day ORBIT): 5 input bands (B03,B04,B08,B11,SCL) →
    8.58 × 5/3 × 2 × 1 ≈ **28.6 PU/side, ≈57 PU/analysis** at the cap.
  - v2 composite (±7 d → N ≈ 3 orbits over Rajasthan: S2A+S2B ≈ 5 d revisit):
    9 input bands (B02,B03,B04,B05,B08,B11,B12,SCL,CLD) → 8.58 × 9/3 × 2 × 3 ≈
    **154 PU/side, ≈309 PU/analysis** → ≈ **5.4× v1** (ratio = 9/5 × N).
    Window ±3 d (N ≈ 1.4) → ≈ 72 PU/side (≈2.5× v1).
  - Cost levers for Phase 2 band-set decisions: fewer input bands (each band = ÷3 of a
    factor, 9→7 saves ~22%), narrower window (N ∝ window), `dataFilter.maxCloudCoverage`
    / `preProcessScenes` (both cut counted samples — officially PU-reducing), and
    16-bit DN output with `units: "DN"` input (removes the ×2 float factor — halving
    v2 PU — at a 1e-4 reflectance quantisation; indices are scale-invariant ratios).
  - Evalscript execution >200 ms adds 0.5 PU/100 ms — our median over ≤ ~3 ORBIT
    samples is far below that (another reason to prefer ORBIT over TILE: TILE counts
    every tile×pass as a sample).
- Render-budget guard remains accurate for composites (still 1 Process render per side →
  2 per analysis); PU metering is separate from `DAILY_RENDER_BUDGET` and needs no
  Phase 1 change (a `PER_ANALYSIS_PU_LIMIT` guard lands with Phase 5).

---

## 6. Vectorization & hotspots (current)

- **Algorithm**: exposed pixel-edge segment tracing, not contours (`polygon.ts:55-88`).
  Every boundary pixel step = one vertex → **stair-step polygons, no simplification anywhere**
  (`polygon.ts:59-63`).
- Labelling is **8-connected** (`filter.ts:104-111`) but edge emission tests **4 orthogonal
  neighbours only** (`polygon.ts:59-62`) → diagonal-only patches can produce self-touching
  rings; open chains are silently dropped (`polygon.ts:82`), iteration guard 4e6
  (`polygon.ts:74`) with no error signal.
- Holes: rings sorted by |area|, attached to first outer containing ring[0] (one nesting level,
  even-odd ray cast) (`polygon.ts:109-127`).
- **Coverage**: only the **top-10 patches by pixel count** are vectorized (`stats.ts:192-211`);
  everything else exists only in the raster overlay/GeoTIFF. GeoJSON export emits exactly those
  hotspots (`lib/compare/export.ts:116-136`).
- Hotspot props: bbox-centre `centroid` (can fall outside an L-shape), bbox, areaHa = pixel
  count × pxAreaHa, class, tehsil by majority pixels (`stats.ts:213-240`). No id, no confidence,
  no sub_label.
- Map: `compare-hotspot-fill/line/hover` layers + DOM markers ranked by index
  (`bridge.ts:338-560`); popup reads `rank/classLabel/areaHa/tehsilName` (`bridge.ts:567-603`).

---

## 7. Statistics & outputs

- Area basis: flat equirectangular `metersX/Y` from grid, single `pxAreaHa` for the whole AOI
  (`grid.ts:5-15`, `stats.ts:38`).
- `CompareStats`: metadata + per-class pixels/ha/% of valid + validPct + tehsil zonal table
  (district level only) + top-10 hotspots + changeBbox + negligible (`types.ts:92-108`).
- Export paths: PNG overlay + GeoTIFF (full grid, nodata 255), stats CSV (all classes/tehsils +
  top-10 hotspots), hotspots GeoJSON (top-10 only). AI prompt: top-15 tehsils + top-10 hotspots
  (`prompt.ts:107-129`).
- Cache key (v1) = sha256(`COMPARE_VERSION="v1"`, areaId, level, dates, sensitivity,
  minPatchHa) — engine version not exposed in stats (`cache.ts:153-171`).
- Store has **no** confidence filter, engine-version, composite-window or events state
  (`useCompareStore.ts:34-72`).

---

## 8. Known weaknesses → v2 mapping

| # | Weakness | Evidence | Addressed by |
|---|---|---|---|
| 1 | Single-date "mostRecent" sample, no cloud-prob filtering, no composite | `fetch.ts:47-51` | Phase 1 |
| 2 | No B02/B05/B12, no BSI/AWEI/brightness/NDWI indices | `evalscript.ts:16` | Phase 1–2 |
| 3 | No radiometric normalization between dates | whole pipeline | Phase 2.1 |
| 4 | No co-registration check/shift correction | `analyze.ts:99-104` | Phase 2.2 |
| 5 | Fixed global thresholds, single scalar sensitivity, no scene adaptation, no metadata of thresholds in use | `config.ts:51-86` | Phase 2.4 |
| 6 | Single-index hard decisions, no 2-of-3 voting, no magnitude/CVA | `classify.ts:60-83` | Phase 2.5 |
| 7 | No confidence/tier anywhere | `types.ts:58-69` | Phase 2.8, 6 |
| 8 | Built-up "confirmed" wording risk, no sub_label | `config.ts:111-119` | Phase 2.5, 7 |
| 9 | No seasonal/crop-cycle handling, no gap rule | `route.ts:33-36` | Phase 2.6 |
| 10 | No persistence check after date B | pipeline | Phase 2.7 |
| 11 | Salt-and-pepper: single majority pass, hard MMU erasure | `filter.ts:14-125` | Phase 3 |
| 12 | Stair-step edges, no sub-pixel contours, 8/4-conn mismatch, self-intersection risk | `polygon.ts` | Phase 3–4 |
| 13 | Top-10 hotspot-only vectors; no full-coverage vector events | `stats.ts:192-211` | Phase 5, 6 |
| 14 | Single-shot grid ≤1500 px → coarse than 10 m for districts | `config.ts:45` | Phase 5 |
| 15 | No PU model / PER_ANALYSIS_PU_LIMIT | `budget.ts` | Phase 5 |
| 16 | No stable event ids, no paged events API | — | Phase 6 |
| 17 | Dead config (`mndwiAfter/Before`), missing threshold echo (`bareBuiltMaxMndwi`) | `config.ts:52-55`, `analyze.ts:148-155` | Phase 2 (fixed with v2) |
| 18 | SCL resampled bilinearly while tested with strict equality | `fetch.ts:53` vs `evalscript.ts:23` | Phase 1 (nearest for SCL) |

---

## 9. Extension points for v2

- **Engine flag**: `CHANGE_ENGINE=v1|v2` env → `lib/env.ts`; branch in
  `app/api/compare/analyze/route.ts` between `runCompare` (v1) and `runCompareV2`.
  Cache key must include engine (else v1/v2 collide) — `compareCacheKey` (`cache.ts:153-171`).
- **Bands**: new evalscript lives next to `lib/analysis/evalscript.ts`; parsing needs band
  count > 5 (`parse.ts:30-40`).
- **Metadata**: `CompareMetadata` (`types.ts:71-90`) + builder (`analyze.ts:134-157`) +
  method card (`CompareStatsTab.tsx:336-383`) + CSV header (`export.ts:63-79`).
- **UI hooks**: confidence slider + composite toggle → `useCompareStore` (new fields), method
  card in `CompareDrawer`, events list replacing hotspots list in `CompareStatsTab`, popup/
  markers in `bridge.ts`, prompt in `prompt.ts`.
- **Events API**: new route `app/api/compare/events/route.ts`, reads from a stored artifact in
  `compareResultCache` (extend `CompareArtifactEntry`, `cache.ts:59-69`).

---

## 10. Baseline validation report

`npm run validate` runs the harness in `validation/` (see `validation/README.md`).
Baseline (engine v1) report: **`validation/reports/v1-baseline.md`**.

Real reference labels are still to be authored in QGIS (see README §"Creating references");
until they exist, the baseline covers the synthetic fixtures only and is marked accordingly.
