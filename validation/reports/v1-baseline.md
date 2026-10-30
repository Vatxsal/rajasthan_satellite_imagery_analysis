# Validation report — engine v1

- Generated: 2026-10-30T02:06:47.087Z
- Cases: 3
- Raster grid long side: 400 px
- Note: synthetic fixtures only — real QGIS references pending (see validation/README.md)

> Metrics are computed on **labeled pixels only** (inside some reference polygon).
> Pixels without a prediction polygon count as `no_change` (the engine emits change objects only).

## Aggregate (all cases, summed confusion)

- Overall accuracy: **89.0%**
- Macro F1 (support > 0): **81.4%**
- Change-vs-no_change F1: **80.7%**

| Class | Precision | Recall | F1 | IoU | Ref px | Pred px | Area error |
|---|---|---|---|---|---|---|---|
| water_gain | 0.0% | — | — | 0.0% | 0 px | 5518 px | — |
| water_loss | — | — | — | — | 0 px | 0 px | — |
| veg_gain | 98.9% | 50.6% | 66.9% | 50.3% | 21760 px | 11129 px | -48.9% |
| veg_loss | 88.5% | 79.5% | 83.7% | 72.0% | 62667 px | 56309 px | -10.1% |
| builtup_gain | 0.0% | — | — | 0.0% | 0 px | 4466 px | — |
| no_change | 92.2% | 94.9% | 93.6% | 87.9% | 239111 px | 246116 px | 2.9% |

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_gain | no_change |
|---|---|---|---|---|---|---|
| **water_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **water_loss** | 0 | 0 | 0 | 0 | 0 | 0 |
| **veg_gain** | 0 | 0 | 11008 | 0 | 0 | 10752 |
| **veg_loss** | 0 | 0 | 0 | 49811 | 4466 | 8390 |
| **builtup_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 5518 | 0 | 121 | 6498 | 0 | 226974 |

## Case: circle-partial
- Grid: 400×334 px, labeled 79.8% of extent
- Overall accuracy: 82.2%, Macro F1: 83.9%, Change F1: 76.3%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| water_gain | 0.0% | — | — | 0.0% | 0.0000 ha | 18.28 ha | — |
| water_loss | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| veg_gain | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| veg_loss | 82.4% | 81.5% | 82.0% | 69.4% | 123.94 ha | 122.52 ha | -1.1% |
| builtup_gain | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| no_change | 89.2% | 82.6% | 85.8% | 75.1% | 229.15 ha | 212.29 ha | -7.4% |

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_gain | no_change |
|---|---|---|---|---|---|---|
| **water_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **water_loss** | 0 | 0 | 0 | 0 | 0 | 0 |
| **veg_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **veg_loss** | 0 | 0 | 0 | 30484 | 0 | 6927 |
| **builtup_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 5518 | 0 | 0 | 6498 | 0 | 57151 |

## Case: lshape-classswap
- Grid: 400×300 px, labeled 92.2% of extent
- Overall accuracy: 94.6%, Macro F1: 92.9%, Change F1: 97.0%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| water_gain | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| water_loss | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| veg_gain | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| veg_loss | 100.0% | 76.5% | 86.7% | 76.5% | 75.24 ha | 57.58 ha | -23.5% |
| builtup_gain | 0.0% | — | — | 0.0% | 0.0000 ha | 13.31 ha | — |
| no_change | 98.3% | 100.0% | 99.2% | 98.3% | 254.24 ha | 258.60 ha | 1.7% |

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_gain | no_change |
|---|---|---|---|---|---|---|
| **water_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **water_loss** | 0 | 0 | 0 | 0 | 0 | 0 |
| **veg_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **veg_loss** | 0 | 0 | 0 | 19327 | 4466 | 1463 |
| **builtup_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 0 | 0 | 0 | 85336 |

## Case: hole-sliver
- Grid: 400×289 px, labeled 92.0% of extent
- Overall accuracy: 89.8%, Macro F1: 80.4%, Change F1: 66.9%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| water_gain | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| water_loss | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| veg_gain | 98.9% | 50.6% | 66.9% | 50.3% | 52.48 ha | 26.84 ha | -48.9% |
| veg_loss | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| builtup_gain | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| no_change | 88.7% | 99.9% | 94.0% | 88.6% | 204.06 ha | 229.70 ha | 12.6% |

| ref \ pred | water_gain | water_loss | veg_gain | veg_loss | builtup_gain | no_change |
|---|---|---|---|---|---|---|
| **water_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **water_loss** | 0 | 0 | 0 | 0 | 0 | 0 |
| **veg_gain** | 0 | 0 | 11008 | 0 | 0 | 10752 |
| **veg_loss** | 0 | 0 | 0 | 0 | 0 | 0 |
| **builtup_gain** | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_change** | 0 | 0 | 121 | 0 | 0 | 84487 |

