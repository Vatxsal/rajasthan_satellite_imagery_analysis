# Phase 6 — legacy vs fused validation

- Generated: 2026-11-09T13:52:59.011Z
- Branch: `feat/accuracy-sar-context`
- Scenarios: 3 synthetic specs × 3 modes × 3 reps (engine wall time), grid long side 400 px
- Fixtures: 3 static manifest case(s) (hold-out entries: 0 — none marked `split: holdout` yet)
- Fused evidence in this harness is **synthetic and truth-derived** (validation/scenarios.ts): the prior is the A-side land-cover truth, SAR water masks mirror the truth transitions, terrain is flat. Gates therefore preserve truth classes **by construction** — this report measures gate correctness / no-regression plus PU, runtime and memory cost. Real-world accuracy gains need human-drawn QGIS references (none exist yet; see validation/README.md).

## Modes

| Mode | Definition |
|---|---|
| v1 (legacy) | Shipped product legacy — CHANGE_ENGINE=v1 default, single-date inputs |
| v2 (legacy) | v2 composite engine with legacy rules (engine isolation control) |
| v2 (fused) | Shipped default — CHANGE_RULES=fused with synthetic truth-derived evidence |

## Aggregate per-class P/R/F1 (summed confusion over the 3 scenarios)

| Class | v1 leg P | v1 leg R | v1 leg F1 | v2 leg P | v2 leg R | v2 leg F1 | v2 fused P | v2 fused R | v2 fused F1 | Δ F1 fused−v2 leg | Δ F1 fused−v1 leg |
|---|---|---|---|---|---|---|---|---|---|---|---|
| water_gain | 100.0% | 99.0% | 99.5% | 100.0% | 99.0% | 99.5% | 100.0% | 99.0% | 99.5% | 0.0 pp | 0.0 pp |
| water_loss | 100.0% | 98.3% | 99.1% | 100.0% | 98.3% | 99.1% | 100.0% | 98.3% | 99.1% | 0.0 pp | 0.0 pp |
| veg_gain | 100.0% | 98.5% | 99.2% | 100.0% | 98.5% | 99.2% | 100.0% | 98.5% | 99.2% | 0.0 pp | 0.0 pp |
| veg_loss | 99.4% | 98.5% | 98.9% | 99.4% | 98.5% | 98.9% | 99.4% | 98.5% | 98.9% | 0.0 pp | 0.0 pp |
| builtup_increase | 100.0% | 99.6% | 99.8% | 100.0% | 99.6% | 99.8% | 100.0% | 99.6% | 99.8% | 0.0 pp | 0.0 pp |
| bare_agri | — | — | — | — | — | — | — | — | — | — | — |
| no_change | 99.8% | 100.0% | 99.9% | 99.8% | 100.0% | 99.9% | 99.8% | 100.0% | 99.9% | 0.0 pp | 0.0 pp |

## Headlines (aggregate)

| Mode | Overall accuracy | Macro F1 (support > 0) | Change F1 | Engine wall time (median of 3) | Heap Δ during build |
|---|---|---|---|---|---|
| v1 (legacy) | 99.8% | 99.4% | 99.2% | 661 ms | 12.1 MB |
| v2 (legacy) | 99.8% | 99.4% | 99.2% | 5629 ms | 59.2 MB |
| v2 (fused) | 99.8% | 99.4% | 99.2% | 5655 ms | 34.6 MB |

> Wall time/heap measured around `buildScenarios` (truth synthesis + classify → denoise → MMU → vectorize) with `node --expose-gc`; heap Δ is post-build minus pre-build `heapUsed` after a forced GC.

## Per-scenario F1 by class (%)

| Scenario | Mode | water_gain | water_loss | veg_gain | veg_loss | builtup_increase | bare_agri | no_change | macroF1 |
|---|---|---|---|---|---|---|---|---|---|
| scenario-classes-v1 | v1 (legacy) | 99.5 | 99.1 | 99.2 | 98.8 | 99.8 | — | 99.9 | 99.4 |
| scenario-speckle-v1 | v1 (legacy) | — | — | — | 99.1 | — | — | 99.9 | 99.5 |
| scenario-clouds-v1 | v1 (legacy) | 99.5 | 99.1 | 99.2 | 98.8 | 99.8 | — | 99.9 | 99.4 |
| scenario-classes-v2-legacy | v2 (legacy) | 99.5 | 99.1 | 99.2 | 98.8 | 99.8 | — | 99.9 | 99.4 |
| scenario-speckle-v2-legacy | v2 (legacy) | — | — | — | 99.1 | — | — | 99.9 | 99.5 |
| scenario-clouds-v2-legacy | v2 (legacy) | 99.5 | 99.1 | 99.2 | 98.8 | 99.8 | — | 99.9 | 99.4 |
| scenario-classes-v2-fused | v2 (fused) | 99.5 | 99.1 | 99.2 | 98.8 | 99.8 | — | 99.9 | 99.4 |
| scenario-speckle-v2-fused | v2 (fused) | — | — | — | 99.1 | — | — | 99.9 | 99.5 |
| scenario-clouds-v2-fused | v2 (fused) | 99.5 | 99.1 | 99.2 | 98.8 | 99.8 | — | 99.9 | 99.4 |

## Confusion (aggregate) — v1 (legacy)

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_increase | bare_agri | no_change |
|---|---|---|---|---|---|---|---|
| **water_gain** | 7696 | 0 | 0 | 0 | 0 | 0 | 76 |
| **water_loss** | 0 | 7750 | 0 | 0 | 0 | 0 | 138 |
| **veg_gain** | 0 | 0 | 10164 | 0 | 0 | 0 | 154 |
| **veg_loss** | 0 | 0 | 0 | 20362 | 0 | 0 | 312 |
| **builtup_increase** | 0 | 0 | 0 | 0 | 8894 | 0 | 38 |
| **bare_agri** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 0 | 126 | 0 | 0 | 386658 |

## Confusion (aggregate) — v2 (legacy)

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_increase | bare_agri | no_change |
|---|---|---|---|---|---|---|---|
| **water_gain** | 7696 | 0 | 0 | 0 | 0 | 0 | 76 |
| **water_loss** | 0 | 7750 | 0 | 0 | 0 | 0 | 138 |
| **veg_gain** | 0 | 0 | 10164 | 0 | 0 | 0 | 154 |
| **veg_loss** | 0 | 0 | 0 | 20362 | 0 | 0 | 312 |
| **builtup_increase** | 0 | 0 | 0 | 0 | 8894 | 0 | 38 |
| **bare_agri** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 0 | 126 | 0 | 0 | 386658 |

## Confusion (aggregate) — v2 (fused)

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_increase | bare_agri | no_change |
|---|---|---|---|---|---|---|---|
| **water_gain** | 7696 | 0 | 0 | 0 | 0 | 0 | 76 |
| **water_loss** | 0 | 7750 | 0 | 0 | 0 | 0 | 138 |
| **veg_gain** | 0 | 0 | 10164 | 0 | 0 | 0 | 154 |
| **veg_loss** | 0 | 0 | 0 | 20362 | 0 | 0 | 312 |
| **builtup_increase** | 0 | 0 | 0 | 0 | 8894 | 0 | 38 |
| **bare_agri** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 0 | 126 | 0 | 0 | 386658 |

## Static fixtures (engine-agnostic harness sanity)

The three manifest fixtures are fixed prediction GeoJSONs — identical under every rule mode, so they are scored once as a harness sanity check (not as a legacy/fused comparison).

| Case | Split | Overall accuracy | Macro F1 | Change F1 | Note |
|---|---|---|---|---|---|
| circle-partial | tune | 82.2% | 83.9% | 76.3% | offset circle + water_gain false positive |
| lshape-classswap | tune | 94.6% | 92.9% | 97.0% | L-shape with class swap (veg_loss vs builtup) and a missing foot |
| hole-sliver | tune | 89.8% | 80.4% | 66.9% | polygon with hole, shrunk inner patch, thin sliver FP |

## Cost of S1 + DEM evidence (v2 composite, window 7)

`prepareCompare` optical base vs base + two S1 renders (`S1_WINDOW_DAYS=6`) + one DEM render — the same cost model the API uses for `PER_ANALYSIS_PU_LIMIT`.

| AOI | Optical base PU | +S1+DEM PU | Δ PU | Δ % |
|---|---|---|---|---|
| Scenario grid (0.04° ≈ 400 px) | 24.10 | 28.12 | +4.02 | +17% |
| Tehsil-size AOI (0.15° ≈ 1500 px cap) | 277.47 | 323.72 | +46.25 | +17% |

## Screenshots (live CDSE, dev server `CHANGE_RULES`)

Captured by `scripts/phase6-sites.browser.cjs` against `next dev` — once with `CHANGE_RULES=legacy` (v1 product legacy) and once with `CHANGE_RULES=fused` (v2 + live S1/WorldCover/DEM evidence), three tehsils each:

| Tehsil (district) | legacy | fused | method card (legacy) | method card (fused) |
|---|---|---|---|---|
| phalodi (Jodhpur) | docs/screenshots/phase6-phalodi-legacy.png | docs/screenshots/phase6-phalodi-fused.png | docs/screenshots/phase6-phalodi-legacy-method.png | docs/screenshots/phase6-phalodi-fused-method.png |
| sanganer (Jaipur) | docs/screenshots/phase6-sanganer-legacy.png | docs/screenshots/phase6-sanganer-fused.png | docs/screenshots/phase6-sanganer-legacy-method.png | docs/screenshots/phase6-sanganer-fused-method.png |
| sangod (Kota) | docs/screenshots/phase6-sangod-legacy.png | docs/screenshots/phase6-sangod-fused.png | docs/screenshots/phase6-sangod-legacy-method.png | docs/screenshots/phase6-sangod-fused-method.png |

## Interpretation

- **No-regression:** fused aggregate macro F1 99.4% vs v2-legacy 99.4% (0.0 pp) and vs v1-legacy 99.4% (0.0 pp) — truth-derived evidence must not move classes; any delta comes only from confidence-aware MMU / sub-label scoring differences.
- **bare_agri:** no current reference set carries bare-agri truth (rows show "—"); the sub-label matcher in `validation/engine.ts` now accepts the engine's full text ("Bare soil on cropland (likely harvest / tillage)") plus the `bare_agri`/`agri_bare` aliases — covered by `scripts/validation.test.ts`.
- **Evidence cost:** +S1+DEM adds the Δ PU shown above (roughly two S1 renders + one DEM render on top of the optical pair); WorldCover prior is a free COG read. Live fetch wall time rides the existing CDSE Process API — no new service.
- **What this cannot show yet:** precision gains on real built-up/water events (Phase 0 baselines: water_gain 0% precision, builtup_increase 0% precision on the first fixture set). Those need human-drawn references over real scenes — the next validation input, not a code change.

## Reproduce

```
npm run phase6                     # this report
npm run validate -- --scenarios --engine v1
npm run validate -- --scenarios --engine v2
npm run validate -- --scenarios --rules fused   # per-mode detail reports
```

