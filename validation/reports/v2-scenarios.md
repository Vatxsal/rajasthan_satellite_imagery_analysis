# Validation report — engine v2 (scenarios)

- Generated: 2026-11-08T06:41:11.274Z
- Cases: 3
- Raster grid long side: 400 px
- Note: scenario fixtures — synthetic A/B rasters through the real engine pipeline (validation/scenarios.ts)

> Metrics are computed on **labeled pixels only** (inside some reference polygon).
> Pixels without a prediction polygon count as `no_change` (the engine emits change objects only).

## Aggregate (all cases, summed confusion)

- Overall accuracy: **99.8%**
- Macro F1 (support > 0): **99.4%**
- Change-vs-no_change F1: **99.2%**

| Class | Precision | Recall | F1 | IoU | Ref px | Pred px | Area error |
|---|---|---|---|---|---|---|---|
| water_gain | 100.0% | 99.0% | 99.5% | 99.0% | 7772 px | 7696 px | -1.0% |
| water_loss | 100.0% | 98.3% | 99.1% | 98.3% | 7888 px | 7750 px | -1.7% |
| veg_gain | 100.0% | 98.5% | 99.2% | 98.5% | 10318 px | 10164 px | -1.5% |
| veg_loss | 99.4% | 98.5% | 98.9% | 97.9% | 20674 px | 20488 px | -0.9% |
| builtup_increase | 100.0% | 99.6% | 99.8% | 99.6% | 8932 px | 8894 px | -0.4% |
| bare_agri | — | — | — | — | 0 px | 0 px | — |
| no_change | 99.8% | 100.0% | 99.9% | 99.8% | 386784 px | 387376 px | 0.2% |

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_increase | bare_agri | no_change |
|---|---|---|---|---|---|---|---|
| **water_gain** | 7696 | 0 | 0 | 0 | 0 | 0 | 76 |
| **water_loss** | 0 | 7750 | 0 | 0 | 0 | 0 | 138 |
| **veg_gain** | 0 | 0 | 10164 | 0 | 0 | 0 | 154 |
| **veg_loss** | 0 | 0 | 0 | 20362 | 0 | 0 | 312 |
| **builtup_increase** | 0 | 0 | 0 | 0 | 8894 | 0 | 38 |
| **bare_agri** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 0 | 126 | 0 | 0 | 386658 |

## Case: scenario-classes-v2
- Dates: 2026-05-01 → 2026-05-20
- Grid: 400×400 px, labeled 92.2% of extent
- Overall accuracy: 99.8%, Macro F1: 99.4%, Change F1: 99.3%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| water_gain | 100.0% | 99.0% | 99.5% | 99.0% | 46.49 ha | 46.04 ha | -1.0% |
| water_loss | 100.0% | 98.3% | 99.1% | 98.3% | 47.19 ha | 46.36 ha | -1.7% |
| veg_gain | 100.0% | 98.5% | 99.2% | 98.5% | 61.72 ha | 60.80 ha | -1.5% |
| veg_loss | 98.9% | 98.7% | 98.8% | 97.6% | 70.93 ha | 70.73 ha | -0.3% |
| builtup_increase | 100.0% | 99.6% | 99.8% | 99.6% | 53.43 ha | 53.20 ha | -0.4% |
| bare_agri | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| no_change | 99.8% | 99.9% | 99.9% | 99.7% | 1484 ha | 1487 ha | 0.2% |

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_increase | bare_agri | no_change |
|---|---|---|---|---|---|---|---|
| **water_gain** | 3848 | 0 | 0 | 0 | 0 | 0 | 38 |
| **water_loss** | 0 | 3875 | 0 | 0 | 0 | 0 | 69 |
| **veg_gain** | 0 | 0 | 5082 | 0 | 0 | 0 | 77 |
| **veg_loss** | 0 | 0 | 0 | 5849 | 0 | 0 | 80 |
| **builtup_increase** | 0 | 0 | 0 | 0 | 4447 | 0 | 19 |
| **bare_agri** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 0 | 63 | 0 | 0 | 124009 |

## Case: scenario-speckle-v2
- Dates: 2026-05-01 → 2026-05-20
- Grid: 400×400 px, labeled 92.2% of extent
- Overall accuracy: 99.9%, Macro F1: 99.5%, Change F1: 99.1%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| water_gain | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| water_loss | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| veg_gain | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| veg_loss | 100.0% | 98.3% | 99.1% | 98.3% | 105.48 ha | 103.66 ha | -1.7% |
| builtup_increase | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| bare_agri | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| no_change | 99.9% | 100.0% | 99.9% | 99.9% | 1659 ha | 1661 ha | 0.1% |

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_increase | bare_agri | no_change |
|---|---|---|---|---|---|---|---|
| **water_gain** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **water_loss** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **veg_gain** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **veg_loss** | 0 | 0 | 0 | 8664 | 0 | 0 | 152 |
| **builtup_increase** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **bare_agri** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 0 | 0 | 0 | 0 | 138640 |

## Case: scenario-clouds-v2
- Dates: 2026-05-01 → 2026-05-20
- Grid: 400×400 px, labeled 92.2% of extent
- Overall accuracy: 99.8%, Macro F1: 99.4%, Change F1: 99.3%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| water_gain | 100.0% | 99.0% | 99.5% | 99.0% | 46.49 ha | 46.04 ha | -1.0% |
| water_loss | 100.0% | 98.3% | 99.1% | 98.3% | 47.19 ha | 46.36 ha | -1.7% |
| veg_gain | 100.0% | 98.5% | 99.2% | 98.5% | 61.72 ha | 60.80 ha | -1.5% |
| veg_loss | 98.9% | 98.7% | 98.8% | 97.6% | 70.93 ha | 70.73 ha | -0.3% |
| builtup_increase | 100.0% | 99.6% | 99.8% | 99.6% | 53.43 ha | 53.20 ha | -0.4% |
| bare_agri | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| no_change | 99.8% | 99.9% | 99.9% | 99.7% | 1484 ha | 1487 ha | 0.2% |

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_increase | bare_agri | no_change |
|---|---|---|---|---|---|---|---|
| **water_gain** | 3848 | 0 | 0 | 0 | 0 | 0 | 38 |
| **water_loss** | 0 | 3875 | 0 | 0 | 0 | 0 | 69 |
| **veg_gain** | 0 | 0 | 5082 | 0 | 0 | 0 | 77 |
| **veg_loss** | 0 | 0 | 0 | 5849 | 0 | 0 | 80 |
| **builtup_increase** | 0 | 0 | 0 | 0 | 4447 | 0 | 19 |
| **bare_agri** | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 0 | 63 | 0 | 0 | 124009 |

