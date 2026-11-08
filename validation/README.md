# Validation harness

Reference-vs-prediction accuracy harness for the change engine. Compares
**reference polygons you draw in QGIS** with **our engine's GeoJSON output** for the same
area/dates, and reports per-class precision / recall / F1 / IoU, a confusion matrix and
per-class area error.

## Quick start

```bash
npm run validate                                   # all TUNE cases in cases.json
npm run validate -- --holdout                      # hold-out cases only (final scoring)
npm run validate -- --case circle-partial          # one case
npm run validate -- --engine v2 --px 512           # custom engine label / grid size
npm run validate -- --out validation/reports/v2.md # custom report path
```

Output: a markdown report (default `validation/reports/v1-baseline.md`) plus a console
summary. The script is offline — it never calls CDSE.

## Files

| Path | Purpose |
|---|---|
| `engine.ts` | Pure core: rasterize both layers on a shared grid, confusion matrix, metrics, report rendering |
| `cases.json` | Manifest of validation cases (reference + prediction paths) |
| `fixtures/` | Synthetic reference/prediction pairs (harness self-test) |
| `references/` | Your real QGIS labels (create this folder, see below) |
| `reports/` | Generated reports (committed baselines) |
| `../scripts/validate.ts` | CLI entry (`npm run validate`) |

## Creating reference labels in QGIS

1. **Pick your AOI and dates first.** Run the analysis in the app for a district/tehsil you
   will label (e.g. Ajmer, dateA/dateB you know well), then export the current prediction:
   drawer → Hotspots tab → **GeoJSON** (this is what `npm run validate` reads as "our output").
   Save it as `validation/references/<case>.prediction.geojson`.
2. In QGIS, add the **exported prediction GeoJSON** and dated very-high-resolution
   imagery you trust for ground truth. **Preferred: Esri Wayback imagery**
   (https://livingatlas.arcgis.com/wayback — free, every Landsat/Sentinel-2 scene
   is archived with its acquisition date): add one XYZ layer dated near **dateA**
   and a second dated near **dateB**, so you digitize what was actually on the
   ground on each analysis date, not today's scene. The app's own true-color
   tiles for a *third*, independent date are a good cross-check; Google/Esri
   current satellite is the fallback when Wayback has no cloud-free scene.
3. Create a new **Polygon layer** (`Layer → Create Layer → New Shapefile/GeoPackage layer`),
   geometry **Polygon**, CRS **EPSG:4326**, and add a **text field named `cls`**
   (optional text fields `dateA`/`dateB` may record which pair you labeled —
   the case-level dates in `cases.json` are authoritative).
4. Digitize polygons over each *clearly changed* area, setting `cls` to exactly one of:

   | `cls` value | Meaning |
   |---|---|
   | `water_gain` | water appeared |
   | `water_loss` | water disappeared |
   | `veg_gain` | vegetation appeared/increased |
   | `veg_loss` | vegetation removed/decreased |
   | `builtup_increase` | bare/built surface increase (construction or bare soil — you cannot separate them from imagery alone; the engine's `possible_builtup`/`bare_surface` sub-labels are scored against this row) |
   | `bare_agri` | bare-soil change on **known cropland** (harvest/tillage — likely crop cycle, not construction) |
   | `no_change` | verified unchanged — **please label representative unchanged areas too** |

   Aliases accepted on both reference and prediction features: `builtup_gain`,
   `bare_built` → `builtup_increase`; `bare_agriculture`, `agri_bare` → `bare_agri`.
   Predictions carrying `sub_label: "bare_agri"` (or `sub`/`subLabel`) score as
   `bare_agri` automatically.
5. **Minimum polygon size: 0.1 ha** (10 native 10 m pixels). Smaller real
   changes are below the engine's 0.2 ha MMU and only add noise — if a change
   is genuinely smaller, draw the 0.1 ha envelope around it and note it in the
   feature's `note` property. Draw *unions* of adjacent small patches rather
   than tracing every pixel.
6. **Balanced sampling per region and season.** Aim for roughly equal numbers
   of polygons per class across at least: (a) ≥ 2 contrasting regions (e.g. an
   arid western tehsil vs. an irrigated eastern one) and (b) ≥ 2 season pairs
   (e.g. kharif→post-harvest and pre-monsoon→monsoon). A set that is all
   farmland from one district in one season will over-fit that regime — note
   each case's region and season pair in its `note` field.
7. Save as `validation/references/<case>.reference.geojson` (any GeoJSON export is fine —
   we read `.geojson`/`.json` FeatureCollections).
8. Register the case in `cases.json`:

   ```json
   { "name": "ajmer-2026-sep-oct",
     "reference": "validation/references/ajmer.reference.geojson",
     "prediction": "validation/references/ajmer.prediction.geojson",
     "dateA": "2026-09-10", "dateB": "2026-10-28" }
   ```

9. **Hold-out set.** Mark ~⅓ of the cases (chosen *before* any tuning, spread
   across the same regions/seasons) with `"split": "holdout"` in `cases.json`.
   `npm run validate` never runs them; only `npm run validate -- --holdout`
   does. Tune thresholds on the tune split, score the hold-out once at the end
   (Phase 6) — if a change makes the hold-out worse, it was over-fitted.
10. `npm run validate` — the report tells you precision (are we hallucinating?), recall (are
   we missing change?) and area error (are we over/under-sizing patches?) **per class**.

### Tips for good labels

- **Label generously**: cover *everything you can verify* inside the analysis extent,
  including `no_change` areas. **Pixels outside every reference polygon are excluded
  from all metrics** (unlabeled ≠ no_change).
- Draw *unions* of small patches — you don't need to trace every pixel.
- For crop parcels decide upfront: label as `veg_loss`/`veg_gain` only if you consider the
  change real ground change; leave seasonally ambiguous fields `no_change` (the v2 engine
  tags those `crop_cycle_likely` instead of deleting them), or as `bare_agri` when the
  ground is clearly bare cropland after harvest.
- Keep each case **inside one district/tehsil extent** so the prediction export lines up.

## How metrics are computed

- Both layers are rasterized on one shared grid (long side `--px`, default 400) using a
  scanline even-odd fill at **pixel centres**.
- Prediction polygons are read from `properties.cls` (snake_case) or
  `properties.classCode` (engine codes 0–5); **pixels without a prediction polygon count
  as `no_change`** (the engine emits change objects only). `masked`/`outside` are dropped.
- Later features overwrite earlier ones (file order) when polygons overlap.
- Only pixels inside **some reference polygon** enter the metrics (labeled mask).
- Per class: `TP/FP/FN` from the confusion matrix → precision, recall, F1, IoU;
  area error = `(pred − ref) / ref` for that class.
- Aggregate report = confusion matrices summed across cases (micro), plus macro F1 over
  classes with support > 0, plus a binary change-vs-no_change F1.

## Synthetic fixtures (harness self-test)

| Case | Exercises |
|---|---|
| `circle-partial` | partial overlap (shifted circle) + false-positive water patch |
| `lshape-classswap` | class swap (ref `veg_loss` vs pred `builtup_increase` via classCode 3) + missed region |
| `hole-sliver` | hole handling, shrunk inner patch, thin sliver false positive |

The fixtures ship with an **authored prediction** (not real engine output) so the harness is
verifiable before any labels exist. The committed baseline report is marked
*"synthetic fixtures only"* until real references are added.
