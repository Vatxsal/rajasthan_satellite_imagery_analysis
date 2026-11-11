# Fields validation report — boundaries + cropping pattern

- Generated: 2026-11-11T10:03:20.088Z
- Cases: 3
- Raster grid long side: 400 px
- Boundary tolerance: 2 px
- Note: synthetic fixtures only — real QGIS references pending (see validation/README.md)

> Field mask metrics treat every pixel outside a reference field as `no_field`
> (true negative — field segmentation has no unlabelled exclusion zone).
> Boundary MCC compares the ±tolerance boundary bands of both layers; class
> metrics cover the pattern classes with `no_field` as the background row/column.

## Aggregate (all cases, summed confusion)

- Field mask — IoU: **83.0%**, precision: **90.7%**, recall: **90.7%**, F1: **90.7%**
- Boundary MCC (mean over 3/3 cases): **0.710**
- Macro F1 over pattern classes (support > 0): **75.6%**

| Class | Precision | Recall | F1 | IoU | Ref px | Pred px | Area error |
|---|---|---|---|---|---|---|---|
| fallow | 94.2% | 77.3% | 84.9% | 73.8% | 67585 px | 55485 px | -17.9% |
| kharif-only | 61.2% | 61.2% | 61.2% | 44.1% | 67585 px | 67585 px | 0.0% |
| rabi-only | 61.2% | 61.2% | 61.2% | 44.1% | 67585 px | 67585 px | 0.0% |
| double-cropped | 95.2% | 95.2% | 95.2% | 90.9% | 67585 px | 67585 px | 0.0% |
| zaid | — | — | — | — | 0 px | 0 px | — |
| evergreen | 0.0% | — | — | 0.0% | 0 px | 12100 px | — |
| unclassified | — | — | — | — | 0 px | 0 px | — |

| ref \ pred | fallow | kharif-only | rabi-only | double-cropped | zaid | evergreen | unclassified | no_field |
|---|---|---|---|---|---|---|---|---|
| **fallow** | 52245 | 0 | 0 | 0 | 0 | 0 | 0 | 15340 |
| **kharif-only** | 0 | 41341 | 23004 | 0 | 0 | 0 | 0 | 3240 |
| **rabi-only** | 0 | 23004 | 41341 | 0 | 0 | 0 | 0 | 3240 |
| **double-cropped** | 0 | 0 | 0 | 64345 | 0 | 0 | 0 | 3240 |
| **zaid** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **evergreen** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **unclassified** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_field** | 3240 | 3240 | 3240 | 3240 | 0 | 12100 | 0 | 119000 |

## Case: fields-aligned
- Note: identical layers — every metric must be perfect
- Grid: 400×400 px, boundary tolerance 2 px
- Field mask — IoU: 100.0%, precision: 100.0%, recall: 100.0%, F1: 100.0% (tp=116964 fp=0 fn=0 tn=43036)
- Boundary MCC: 1.000, Macro F1: 100.0%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| fallow | 100.0% | 100.0% | 100.0% | 100.0% | 17.58 ha | 17.58 ha | 0.0% |
| kharif-only | 100.0% | 100.0% | 100.0% | 100.0% | 17.58 ha | 17.58 ha | 0.0% |
| rabi-only | 100.0% | 100.0% | 100.0% | 100.0% | 17.58 ha | 17.58 ha | 0.0% |
| double-cropped | 100.0% | 100.0% | 100.0% | 100.0% | 17.58 ha | 17.58 ha | 0.0% |
| zaid | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| evergreen | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| unclassified | — | — | — | — | 0.0000 ha | 0.0000 ha | — |

| ref \ pred | fallow | kharif-only | rabi-only | double-cropped | zaid | evergreen | unclassified | no_field |
|---|---|---|---|---|---|---|---|---|
| **fallow** | 29241 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **kharif-only** | 0 | 29241 | 0 | 0 | 0 | 0 | 0 | 0 |
| **rabi-only** | 0 | 0 | 29241 | 0 | 0 | 0 | 0 | 0 |
| **double-cropped** | 0 | 0 | 0 | 29241 | 0 | 0 | 0 | 0 |
| **zaid** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **evergreen** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **unclassified** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_field** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 43036 |

## Case: fields-shifted-swap
- Note: prediction shifted ~50 m east + kharif/rabi class swap on A and B
- Grid: 400×379 px, boundary tolerance 2 px
- Field mask — IoU: 78.0%, precision: 87.7%, recall: 87.7%, F1: 87.7% (tp=92016 fp=12960 fn=12960 tn=33664)
- Boundary MCC: 0.403, Macro F1: 87.7%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| fallow | 87.7% | 87.7% | 87.7% | 78.0% | 17.57 ha | 17.57 ha | 0.0% |
| kharif-only | 0.0% | 0.0% | — | 0.0% | 17.57 ha | 17.57 ha | 0.0% |
| rabi-only | 0.0% | 0.0% | — | 0.0% | 17.57 ha | 17.57 ha | 0.0% |
| double-cropped | 87.7% | 87.7% | 87.7% | 78.0% | 17.57 ha | 17.57 ha | 0.0% |
| zaid | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| evergreen | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| unclassified | — | — | — | — | 0.0000 ha | 0.0000 ha | — |

| ref \ pred | fallow | kharif-only | rabi-only | double-cropped | zaid | evergreen | unclassified | no_field |
|---|---|---|---|---|---|---|---|---|
| **fallow** | 23004 | 0 | 0 | 0 | 0 | 0 | 0 | 3240 |
| **kharif-only** | 0 | 0 | 23004 | 0 | 0 | 0 | 0 | 3240 |
| **rabi-only** | 0 | 23004 | 0 | 0 | 0 | 0 | 0 | 3240 |
| **double-cropped** | 0 | 0 | 0 | 23004 | 0 | 0 | 0 | 3240 |
| **zaid** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **evergreen** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **unclassified** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_field** | 3240 | 3240 | 3240 | 3240 | 0 | 0 | 0 | 33664 |

## Case: fields-missed
- Note: field D missed entirely, spurious field E added
- Grid: 400×257 px, boundary tolerance 2 px
- Field mask — IoU: 60.0%, precision: 75.0%, recall: 75.0%, F1: 75.0% (tp=36300 fp=12100 fn=12100 tn=42300)
- Boundary MCC: 0.727, Macro F1: 100.0%

| Class | Precision | Recall | F1 | IoU | Area (ref) | Area (pred) | Area error |
|---|---|---|---|---|---|---|---|
| fallow | — | 0.0% | — | 0.0% | 17.61 ha | 0.0000 ha | -100.0% |
| kharif-only | 100.0% | 100.0% | 100.0% | 100.0% | 17.61 ha | 17.61 ha | 0.0% |
| rabi-only | 100.0% | 100.0% | 100.0% | 100.0% | 17.61 ha | 17.61 ha | 0.0% |
| double-cropped | 100.0% | 100.0% | 100.0% | 100.0% | 17.61 ha | 17.61 ha | 0.0% |
| zaid | — | — | — | — | 0.0000 ha | 0.0000 ha | — |
| evergreen | 0.0% | — | — | 0.0% | 0.0000 ha | 17.61 ha | — |
| unclassified | — | — | — | — | 0.0000 ha | 0.0000 ha | — |

| ref \ pred | fallow | kharif-only | rabi-only | double-cropped | zaid | evergreen | unclassified | no_field |
|---|---|---|---|---|---|---|---|---|
| **fallow** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 12100 |
| **kharif-only** | 0 | 12100 | 0 | 0 | 0 | 0 | 0 | 0 |
| **rabi-only** | 0 | 0 | 12100 | 0 | 0 | 0 | 0 | 0 |
| **double-cropped** | 0 | 0 | 0 | 12100 | 0 | 0 | 0 | 0 |
| **zaid** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **evergreen** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **unclassified** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **no_field** | 0 | 0 | 0 | 0 | 0 | 12100 | 0 | 42300 |

