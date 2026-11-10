"""Print a compact summary of out/metrics.json."""

import json
from pathlib import Path

m = json.loads((Path(__file__).parent / "out" / "metrics.json").read_text())
for site, r in m.items():
    a = r["protocolA"]
    print(site.upper())
    for k in ("bicubic", "sen2sr", "ldsr"):
        d = a[k]
        print(
            f"  A {k:8s} PSNR {d['mean_band_psnr']:.2f}  SSIM {d['mean_band_ssim']:.3f}"
            f"  RGB-PSNR {d['RGB']['psnr']:.2f}"
            f"  R/G/B/N {d['R']['psnr']:.1f}/{d['G']['psnr']:.1f}"
            f"/{d['B']['psnr']:.1f}/{d['NIR']['psnr']:.1f}"
        )
    b = r["protocolB"]["cycle_consistency"]
    print(
        f"  B cycle RMSE sen2sr={b['sen2sr']['rmse_mean']:.5f}"
        f" ldsr={b['ldsr']['rmse_mean']:.5f}"
        f"  timings A={a['timing_s']} B={r['protocolB']['timing_s']}"
    )
