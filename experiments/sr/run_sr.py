"""Super-resolution experiment on 5 Rajasthan Sentinel-2 patches.

Models (both free, local, CPU):
  - SEN2SR-Lite NonReference_RGBN_x4  (ESA OpenSR, pip sen2sr)
  - LDSR-S2                           (ESA OpenSR, pip opensr-model)

Both take 4-band [R,G,B,NIR] reflectance in [0,1] and upscale x4
(10 m -> 2.5 m semantics).

Protocol A - reduced-resolution (Wald-style, quantitative):
  GT  = real 10 m patch 512x512
  LR  = bicubic 4x downsample -> 128x128
  out = model(LR) -> 512x512, compared to GT with PSNR / SSIM.
  Baseline = bicubic upsampling of the same LR.

Protocol B - real 10 m -> 2.5 m product (qualitative + cycle consistency):
  out = model(native 10 m patch) -> 2048x2048
  cycle RMSE = box-downsample(out, 4) vs input.
  Montages: full view + zoom crop.

Run from experiments/sr:  .venv\\Scripts\\python.exe run_sr.py [site ...]
"""

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from omegaconf import OmegaConf
from PIL import Image, ImageDraw, ImageFont
from skimage.metrics import structural_similarity as ssim_fn

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
OUT = ROOT / "out"
MODELS = ROOT / "models"
for d in (OUT, MODELS):
    d.mkdir(exist_ok=True)

SITES = ["alwar", "jaipur", "jaisalmer", "udaipur", "bharatpur"]
SEED = 42
torch.manual_seed(SEED)
np.random.seed(SEED)


# ----------------------------------------------------------------- metrics
def psnr(gt: np.ndarray, pred: np.ndarray) -> float:
    mse = float(np.mean((gt - pred) ** 2))
    return 10.0 * np.log10(1.0 / max(mse, 1e-12))


def ssim(gt: np.ndarray, pred: np.ndarray) -> float:
    return float(ssim_fn(gt, pred, data_range=1.0))


def band_metrics(gt: np.ndarray, pred: np.ndarray) -> dict:
    """gt/pred: (4,H,W) in [0,1]."""
    pred = np.clip(pred, 0.0, 1.0)
    out = {}
    names = ["R", "G", "B", "NIR"]
    for i, n in enumerate(names):
        out[n] = {"psnr": psnr(gt[i], pred[i]), "ssim": ssim(gt[i], pred[i])}
    rgb_gt = np.moveaxis(gt[:3], 0, -1)
    rgb_pr = np.moveaxis(np.clip(pred[:3], 0, 1), 0, -1)
    out["RGB"] = {
        "psnr": psnr(rgb_gt, rgb_pr),
        "ssim": float(ssim_fn(rgb_gt, rgb_pr, data_range=1.0, channel_axis=2)),
    }
    out["mean_band_psnr"] = float(np.mean([out[n]["psnr"] for n in names]))
    out["mean_band_ssim"] = float(np.mean([out[n]["ssim"] for n in names]))
    return out


# ----------------------------------------------------------------- models
def load_models():
    import mlstac
    import sen2sr
    import opensr_model

    print("== loading SEN2SR-Lite NonReference_RGBN_x4 ==")
    ml_json = (
        "https://huggingface.co/tacofoundation/sen2sr/resolve/main/"
        "SEN2SRLite/NonReference_RGBN_x4/mlm.json"
    )
    mlstac.download(file=ml_json, output_dir=str(MODELS / "SEN2SRLite_RGBN"))
    t0 = time.perf_counter()
    s2_model = mlstac.load(str(MODELS / "SEN2SRLite_RGBN")).compiled_model(
        device="cpu"
    )
    s2_model.eval()
    print(f"  loaded in {time.perf_counter() - t0:.1f}s")

    print("== loading LDSR-S2 (opensr-model) ==")
    cfg_path = Path(opensr_model.__file__).parent / "configs" / "config_10m.yaml"
    config = OmegaConf.load(str(cfg_path))
    t0 = time.perf_counter()
    ldsr = opensr_model.SRLatentDiffusion(config, device="cpu")
    ldsr.load_pretrained(config.ckpt_version)  # downloads .ckpt to CWD if absent
    ldsr.eval()
    print(f"  loaded in {time.perf_counter() - t0:.1f}s")
    return s2_model, ldsr


# ---------------------------------------------------------- LDSR tiling
def _feather(size: int, ov: int, lo: bool, hi: bool) -> np.ndarray:
    w = np.ones(size, dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, ov, endpoint=False, dtype=np.float32)
    if lo:
        w[:ov] = ramp
    if hi:
        w[-ov:] = ramp[::-1]
    return w


def tiled_sr(model, x: torch.Tensor, chunk: int = 128, overlap: int = 32) -> torch.Tensor:
    """Tile (4,H,W) through a 128-px model with feathered stitching -> (4,4H,4W)."""
    c, h, w = x.shape
    step = chunk - overlap
    xs = list(range(0, w - chunk + 1, step))
    ys = list(range(0, h - chunk + 1, step))
    if xs[-1] + chunk != w:
        xs.append(w - chunk)
    if ys[-1] + chunk != h:
        ys.append(h - chunk)
    out = torch.zeros((c, h * 4, w * 4), dtype=torch.float32)
    wsum = torch.zeros((1, h * 4, w * 4), dtype=torch.float32)
    ov4 = overlap * 4
    total = len(ys) * len(xs)
    n = 0
    for yi, y in enumerate(ys):
        for xi, x0 in enumerate(xs):
            n += 1
            print(f"    tile {n}/{total}", flush=True)
            tile = model(x[:, y : y + chunk, x0 : x0 + chunk][None]).squeeze(0)
            wy = _feather(chunk * 4, ov4, yi > 0, yi < len(ys) - 1)
            wx = _feather(chunk * 4, ov4, xi > 0, xi < len(xs) - 1)
            wtile = torch.from_numpy(np.outer(wy, wx))[None]
            out[:, y * 4 : (y + chunk) * 4, x0 * 4 : (x0 + chunk) * 4] += tile * wtile
            wsum[:, y * 4 : (y + chunk) * 4, x0 * 4 : (x0 + chunk) * 4] += wtile
    assert float(wsum.min()) > 0, "zero-weight pixels in stitch"
    return out / wsum


# ------------------------------------------------------------- montage
def _to_img(arr: np.ndarray) -> Image.Image:
    return Image.fromarray((np.clip(arr, 0, 1) * 255).astype("uint8"))


def _label(img: Image.Image, text: str) -> Image.Image:
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.load_default(size=22)
    except TypeError:  # older Pillow
        font = ImageFont.load_default()
    draw.rectangle([0, 0, img.width, 34], fill=(0, 0, 0))
    draw.text((8, 6), text, fill=(255, 255, 0), font=font)
    return img


def montage(panels: list[tuple[np.ndarray, str]], path: Path) -> None:
    imgs = [_label(_to_img(a), t) for a, t in panels]
    w, h = imgs[0].size
    canvas = Image.new("RGB", (w * len(imgs), h))
    for i, im in enumerate(imgs):
        canvas.paste(im, (i * w, 0))
    canvas.save(path)


def rgb(a: np.ndarray) -> np.ndarray:
    return np.moveaxis(a[:3], 0, -1)


def nearest_x4(a: np.ndarray) -> np.ndarray:
    """(h,w,3) -> (4h,4w,3) nearest-neighbour upscale for display."""
    return np.repeat(np.repeat(a, 4, 0), 4, 1)


# ---------------------------------------------------------- protocols
def box_down(x4: np.ndarray) -> np.ndarray:
    c, h, w = x4.shape
    return x4.reshape(c, h // 4, 4, w // 4, 4).mean(axis=(2, 4))


def run_site(site: str, s2_model, ldsr) -> dict:
    print(f"\n===== {site} =====")
    gt = np.load(DATA / f"{site}_reflectance.npy").astype(np.float32)
    assert gt.shape == (4, 512, 512), gt.shape
    meta = json.loads((DATA / f"{site}_meta.json").read_text())
    res: dict = {"meta": meta, "protocolA": {}, "protocolB": {}}

    # ---------------- Protocol A ----------------
    gt_t = torch.from_numpy(gt)
    lr = F.interpolate(gt_t[None], size=(128, 128), mode="bicubic", antialias=True)
    lr = lr.clamp(0, 1)
    baseline = (
        F.interpolate(lr, size=(512, 512), mode="bicubic", antialias=True)
        .clamp(0, 1)
        .squeeze(0)
        .numpy()
    )

    t0 = time.perf_counter()
    with torch.no_grad():
        a_sen2 = s2_model(lr).clamp(0, 1).squeeze(0).numpy()
    t_sen2 = time.perf_counter() - t0

    t0 = time.perf_counter()
    with torch.no_grad():
        a_ldsr = ldsr(lr).clamp(0, 1).squeeze(0).numpy()
    t_ldsr = time.perf_counter() - t0
    print(f"  A: sen2sr {t_sen2:.1f}s  ldsr {t_ldsr:.1f}s")

    pa = {
        "bicubic": band_metrics(gt, baseline),
        "sen2sr": band_metrics(gt, a_sen2),
        "ldsr": band_metrics(gt, a_ldsr),
        "timing_s": {"sen2sr": round(t_sen2, 2), "ldsr": round(t_ldsr, 2)},
    }
    res["protocolA"] = pa
    for k in ("bicubic", "sen2sr", "ldsr"):
        m = pa[k]
        print(
            f"  A {k:8s} meanPSNR={m['mean_band_psnr']:.2f} "
            f"meanSSIM={m['mean_band_ssim']:.3f}"
        )

    # montage A: full row + zoom row (all detail panels nearest-upscaled x4)
    cz = (192, 192, 320, 320)
    full = [
        (rgb(gt), "Ground truth 10 m"),
        (rgb(baseline), "Bicubic x4 (baseline)"),
        (rgb(a_sen2), "SEN2SR-Lite"),
        (rgb(a_ldsr), "LDSR-S2 (OpenSR)"),
    ]
    zoom = [
        (nearest_x4(rgb(gt[:, cz[1] : cz[3], cz[0] : cz[2]])), "GT (detail)"),
        (nearest_x4(rgb(baseline[:, cz[1] : cz[3], cz[0] : cz[2]])), "Bicubic (detail)"),
        (nearest_x4(rgb(a_sen2[:, cz[1] : cz[3], cz[0] : cz[2]])), "SEN2SR (detail)"),
        (nearest_x4(rgb(a_ldsr[:, cz[1] : cz[3], cz[0] : cz[2]])), "LDSR (detail)"),
    ]
    imgs = [_label(_to_img(a), t) for a, t in full + zoom]
    canvas = Image.new("RGB", (512 * 4, 512 * 2))
    for i, im in enumerate(imgs):
        canvas.paste(im, ((i % 4) * 512, (i // 4) * 512))
    canvas.save(OUT / f"{site}_protocolA.png")

    # ---------------- Protocol B ----------------
    t0 = time.perf_counter()
    with torch.no_grad():
        b_sen2 = sen2sr_predict(s2_model, gt_t).clamp(0, 1).numpy()
    t_b_sen2 = time.perf_counter() - t0

    t0 = time.perf_counter()
    with torch.no_grad():
        b_ldsr = tiled_sr(ldsr, gt_t).clamp(0, 1).numpy()
    t_b_ldsr = time.perf_counter() - t0
    print(f"  B: sen2sr {t_b_sen2:.1f}s  ldsr {t_b_ldsr:.1f}s")

    def cycle(out: np.ndarray) -> dict:
        back = box_down(out)
        rmse = np.sqrt(np.mean((back - gt) ** 2, axis=(1, 2)))
        return {
            "rmse_per_band": [round(float(v), 5) for v in rmse],
            "rmse_mean": round(float(rmse.mean()), 5),
        }

    res["protocolB"] = {
        "timing_s": {"sen2sr": round(t_b_sen2, 2), "ldsr": round(t_b_ldsr, 2)},
        "cycle_consistency": {"sen2sr": cycle(b_sen2), "ldsr": cycle(b_ldsr)},
        "output_shape": list(b_sen2.shape),
    }
    print(f"  B cycle RMSE sen2sr={res['protocolB']['cycle_consistency']['sen2sr']['rmse_mean']}"
          f" ldsr={res['protocolB']['cycle_consistency']['ldsr']['rmse_mean']}")

    # montage B: full row (downscaled to 512) + zoom row (native 512 crops)
    def down(a: np.ndarray) -> np.ndarray:
        t = torch.from_numpy(a)[None]
        return (
            F.interpolate(t, size=(512, 512), mode="area").squeeze(0).numpy()
        )

    full_b = [
        (rgb(down(np.repeat(np.repeat(gt, 4, 1), 4, 2))), "Input 10 m x4 (baseline)"),
        (rgb(down(b_sen2)), "SEN2SR 2.5 m"),
        (rgb(down(b_ldsr)), "LDSR-S2 2.5 m"),
    ]
    zoom_b = [
        (
            np.repeat(
                np.repeat(rgb(gt[:, cz[1] : cz[3], cz[0] : cz[2]]), 4, 0), 4, 1
            ),
            "Input x4 (detail)",
        ),
        (
            rgb(
                b_sen2[
                    :,
                    cz[1] * 4 : cz[3] * 4,
                    cz[0] * 4 : cz[2] * 4,
                ]
            ),
            "SEN2SR (detail)",
        ),
        (
            rgb(
                b_ldsr[
                    :,
                    cz[1] * 4 : cz[3] * 4,
                    cz[0] * 4 : cz[2] * 4,
                ]
            ),
            "LDSR-S2 (detail)",
        ),
    ]
    imgs = [_label(_to_img(a), t) for a, t in full_b + zoom_b]
    canvas = Image.new("RGB", (512 * 3, 512 * 2))
    for i, im in enumerate(imgs):
        canvas.paste(im, ((i % 3) * 512, (i // 3) * 512))
    canvas.save(OUT / f"{site}_protocolB.png")

    return res


def sen2sr_predict(model, x: torch.Tensor) -> torch.Tensor:
    import sen2sr

    return sen2sr.predict_large(x, model, overlap=32)


def main() -> int:
    args = sys.argv[1:]
    montage_a_only = bool(args) and args[0] == "--montage-a"
    if montage_a_only:
        args = args[1:]
    sites = args or SITES
    s2_model, ldsr = load_models()
    results = {}
    out_path = OUT / "metrics.json"
    if out_path.exists():
        results = json.loads(out_path.read_text())
    for site in sites:
        if montage_a_only:
            regenerate_protocol_a_montage(site, s2_model, ldsr)
        else:
            results[site] = run_site(site, s2_model, ldsr)
            out_path.write_text(json.dumps(results, indent=2))
    print(f"\nwrote {out_path if not montage_a_only else OUT}")
    return 0


def regenerate_protocol_a_montage(site: str, s2_model, ldsr) -> None:
    """Re-run protocol A inference and rewrite <site>_protocolA.png only."""
    print(f"\n===== {site} (protocol A montage only) =====")
    gt = np.load(DATA / f"{site}_reflectance.npy").astype(np.float32)
    gt_t = torch.from_numpy(gt)
    lr = F.interpolate(gt_t[None], size=(128, 128), mode="bicubic", antialias=True)
    lr = lr.clamp(0, 1)
    baseline = (
        F.interpolate(lr, size=(512, 512), mode="bicubic", antialias=True)
        .clamp(0, 1)
        .squeeze(0)
        .numpy()
    )
    with torch.no_grad():
        a_sen2 = s2_model(lr).clamp(0, 1).squeeze(0).numpy()
        a_ldsr = ldsr(lr).clamp(0, 1).squeeze(0).numpy()

    cz = (192, 192, 320, 320)
    full = [
        (rgb(gt), "Ground truth 10 m"),
        (rgb(baseline), "Bicubic x4 (baseline)"),
        (rgb(a_sen2), "SEN2SR-Lite"),
        (rgb(a_ldsr), "LDSR-S2 (OpenSR)"),
    ]
    zoom = [
        (nearest_x4(rgb(gt[:, cz[1] : cz[3], cz[0] : cz[2]])), "GT (detail)"),
        (nearest_x4(rgb(baseline[:, cz[1] : cz[3], cz[0] : cz[2]])), "Bicubic (detail)"),
        (nearest_x4(rgb(a_sen2[:, cz[1] : cz[3], cz[0] : cz[2]])), "SEN2SR (detail)"),
        (nearest_x4(rgb(a_ldsr[:, cz[1] : cz[3], cz[0] : cz[2]])), "LDSR (detail)"),
    ]
    imgs = [_label(_to_img(a), t) for a, t in full + zoom]
    canvas = Image.new("RGB", (512 * 4, 512 * 2))
    for i, im in enumerate(imgs):
        canvas.paste(im, ((i % 4) * 512, (i // 4) * 512))
    canvas.save(OUT / f"{site}_protocolA.png")
    print(f"  wrote {OUT / f'{site}_protocolA.png'}")


if __name__ == "__main__":
    raise SystemExit(main())
