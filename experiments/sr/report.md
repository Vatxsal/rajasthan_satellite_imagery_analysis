# Super-Resolution Experiment: SEN2SR & ESA OpenSR LDSR-S2 on Rajasthan

**Status: standalone experiment — NOT integrated into the application.**
All code, weights and data live under `experiments/sr/` and are ignored by the
app build. Integration would require an explicit go-ahead.

Date: 2026-11-10 · Environment: Windows, Python 3.13, PyTorch 2.15 (CPU only,
12 cores, no GPU) · Total compute: ~2 h CPU inference.

## 1. Models

| Model | Package | Weights | Input → Output |
|---|---|---|---|
| SEN2SR-Lite `NonReference_RGBN_x4` | `sen2sr` 0.8.5 (PyPI) | `tacofoundation/sen2sr` via mlstac | 4-band 128×128 @10 m → 512×512 @2.5 m |
| LDSR-S2 | `opensr-model` 1.2.2 (PyPI) | `simon-donike/RS-SR-LTDF` (`opensr-ldsrs2_v1_0_0.ckpt`, 113.6 M-param latent diffusion) | 4-band 100–128 px → ×4, 3-step DPM-Solver++ + spectral back-projection |

Both are ESA Φ-lab OpenSR releases (free, open, no service calls at inference).
Band order for both: **[B04, B03, B02, B08] = [R, G, B, NIR]**, reflectance
`DN/10000` clipped to [0, 1]. SEN2SR is a deterministic feed-forward CNN/SWIN
stack wrapped with a Fourier hard constraint; LDSR-S2 is a stochastic diffusion
model (seed fixed to 42 here).

## 2. Data

512×512 patches (5.12 km², 10 m/px, RGB+NIR) from Sentinel-2 L2A via the open
Element84 Earth Search STAC (no credentials). Scenes picked automatically:
newest item with < 25 % scene cloud whose patch passes a white-cloud heuristic
(< 10 %). All landed in the clear post-monsoon window of Nov 2026.

| Site | Centre | Date | Item | Land cover | Patch cloud |
|---|---|---|---|---|---|
| Alwar | 27.553 N, 76.635 E | 2026-11-09 | S2C_43RFL | Aravalli foothills + city + fields | 0.000 |
| Jaipur | 26.912 N, 75.787 E | 2026-11-09 | S2C_43REK | dense urban | 0.001 |
| Jaisalmer | 26.915 N, 70.912 E | 2026-11-05 | S2C_42RXQ | Thar desert town | 0.001 |
| Udaipur | 24.580 N, 73.680 E | 2026-11-07 | S2B_43RCH | lakes + city + hills | 0.001 |
| Bharatpur | 27.167 N, 77.510 E | 2026-11-09 | S2C_43RGL | Keoladeo wetland | 0.000 |

The Nov 2026 scenes are physically real but winter-low in brightness (mean
reflectance ≈ 0.05–0.15 over most patches) — a limitation noted in §6.

## 3. Protocol A — reduced-resolution (quantitative)

Classic Wald-style setup with the real 10 m patch as ground truth:

```
GT  = real 10 m patch (512×512)
LR  = bicubic 4× downsample (128×128)
out = model(LR) → 512×512        baseline = bicubic upsample(LR)
score = PSNR / SSIM vs GT (data_range 1.0, per band + mean)
```

### Results (mean over R/G/B/N bands)

| Site | Bicubic PSNR / SSIM | SEN2SR PSNR / SSIM | LDSR-S2 PSNR / SSIM |
|---|---|---|---|
| Alwar | 36.97 / 0.853 | **37.37 / 0.870** | 35.68 / 0.824 |
| Jaipur | 29.79 / 0.642 | **30.21 / 0.695** | 28.68 / 0.610 |
| Jaisalmer | 30.90 / 0.704 | **31.25 / 0.745** | 29.86 / 0.675 |
| Udaipur | 30.15 / 0.724 | **30.67 / 0.770** | 29.08 / 0.704 |
| Bharatpur | 40.59 / 0.927 | **41.17 / 0.937** | 39.57 / 0.918 |
| **Mean** | 33.68 / 0.770 | **34.13 / 0.803** | 32.57 / 0.746 |

- **SEN2SR beats bicubic on every site, every band** (PSNR +0.35…+0.58 dB,
  mean **+0.45 dB**; SSIM +0.010…+0.053, mean **+0.033**). It reconstructs
  structure closer to the true 10 m signal than plain upsampling.
- **LDSR-S2 loses to bicubic on every site** (mean **−1.11 dB**, SSIM −0.024),
  yet its outputs *look* the sharpest of the three: it trades pixel-faithfulness
  for plausible hallucinated texture — the classic generative-SR trade-off,
  and exactly what OpenSR's own "trustworthy SR" framing warns about.
- NIR is the hardest band (e.g. Alwar NIR 33.7 dB vs green 38.6 dB).

Montages: `out/<site>_protocolA.png` (row 1: GT | bicubic | SEN2SR | LDSR;
row 2: matched detail crops, nearest ×4). Observed on Jaipur detail: bicubic is
structureless mush; SEN2SR is smoother than GT but keeps roads/blocks aligned;
LDSR shows crisp edges and grid texture that do **not** match GT pixel-for-pixel
— consistent with its worse PSNR.

## 4. Protocol B — real 10 m → 2.5 m product (qualitative + cycle)

Both models ingest the **native 10 m patch** and emit a 2048×2048 "2.5 m"
product (SEN2SR via `sen2sr.predict_large`, overlap 32; LDSR via a
feather-stitched 128-px tiler, 25 tiles). Without 2.5 m ground truth for
Rajasthan we can only score **cycle consistency**: box-downsample the output ×4
and compare against the input.

| Site | SEN2SR cycle RMSE | LDSR-S2 cycle RMSE | SEN2SR time | LDSR time |
|---|---|---|---|---|
| Alwar | 0.00153 | 0.00002 | 5.2 s | 1089 s |
| Jaipur | 0.00366 | 0.00051 | 4.9 s | 998 s |
| Jaisalmer | 0.00350 | 0.00005 | 4.9 s | 966 s |
| Udaipur | 0.00370 | 0.00077 | 4.6 s | 1165 s |
| Bharatpur | 0.00135 | 0.00002 | 4.8 s | 897 s |
| **Mean** | **0.00275** | **0.00027** | **4.9 s** | **1023 s (~17 min)** |

- Both outputs are radiometrically faithful to their input at the sub-percent
  level. LDSR's spectral back-projection makes it near-exact (≤ 7.7e-4);
  SEN2SR deviates up to 0.37 % reflectance RMS.
- Speed on CPU: SEN2SR is ~200× faster than LDSR (5 s vs ~17 min per scene).
  LDSR's diffusion sampler (3 steps) plus per-tile back-projection dominates;
  GPU inference would change this materially, CPU would not.

Montages: `out/<site>_protocolB.png` (row 1: input×4 baseline | SEN2SR 2.5 m |
LDSR 2.5 m; row 2: matched 10 m detail crops at native 2.5 m for the SR
outputs). Full metrics: `out/metrics.json`.

## 5. Verdict

1. **SEN2SR-Lite** — modest but *consistent* gains over bicubic on real
   Rajasthan scenes (+0.45 dB / +0.033 SSIM), fast on CPU, near-cycle-conservative.
   The only one of the two that demonstrably improves reconstruction.
2. **LDSR-S2** — visually the sharpest and best cycle-consistent, but it does
   not beat bicubic on reduced-resolution reconstruction metrics: its extra
   detail is invented, not recovered. Beautiful preview, unreliable measurement.
3. **Neither model is integrated.** Any future use would be as a clearly
   labelled *visual-only preview* (never feeding statistics/classification),
   gated behind a flag, after (a) evaluation against real 2.5 m references
   (e.g. SEN2NEON/SEN2NAIP — neither covers Rajasthan), and (b) an explicit
   decision from the project owner.

## 6. Limitations (honest)

- **Synthetic degradation.** Protocol A asks models to invert a bicubic 4×
  downscale they were not trained on (they are trained on real sensor
  degradation pairs, SEN2NAIP). Numbers measure reconstruction fidelity under
  this proxy, not true super-resolution skill. The field-standard fix is
  SEN2NEON-style real HR references, unavailable here.
- **No 2.5 m ground truth for Rajasthan**, so Protocol B has no absolute
  quality metric — only cycle consistency, which cannot detect hallucination.
- **Dark winter scenes** (Nov, low sun + atmosphere): models were trained on
  brighter composites; outputs may be conservative.
- **Single stochastic seed** for LDSR (seed 42); its metrics vary run to run.
- **CPU-only**: timings are an upper bound; conclusions on quality are
  unaffected.
- Scene-level cloud filtering + a simple patch heuristic; all five patches were
  verified visually cloud-free.

## 7. Reproduce

```powershell
cd experiments/sr
python -m venv .venv
.venv\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\pip install sen2sr opensr-model mlstac numpy pillow requests rasterio pystac-client scikit-image omegaconf
.venv\Scripts\python fetch_data.py            # ~1 min, 5 patches from STAC
.venv\Scripts\python run_sr.py                # ~2 h CPU (weights cached in ./models + ./opensr-ldsrs2_v1_0_0.ckpt)
.venv\Scripts\python summarize.py             # metric tables from out/metrics.json
```

Outputs land in `out/` (gitignored): `metrics.json`, `*_protocolA.png`,
`*_protocolB.png`.
