"""Fetch 512x512 Sentinel-2 L2A patches (RGB+NIR, 10 m) for 5 Rajasthan sites.

Source: Element84 Earth Search (open STAC, no credentials).
Output per site: data/<site>_reflectance.npy (4,512,512) float32 [R,G,B,N] in
[0,1], data/<site>_preview.png, data/<site>_meta.json.
"""

import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from pystac_client import Client
from PIL import Image
from rasterio.windows import Window
from rasterio.warp import transform

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)

STAC_URL = "https://earth-search.aws.element84.com/v1"
DATETIME = "2025-01-01T00:00:00Z/2026-11-10T00:00:00Z"
PATCH = 512
ASSET_ORDER = ["red", "green", "blue", "nir"]  # -> [R, G, B, N]

SITES = {
    # name: (lat, lon) — diverse land cover across Rajasthan
    "alwar": (27.553, 76.635),       # Aravalli foothills + city + fields
    "jaipur": (26.912, 75.787),      # dense urban
    "jaisalmer": (26.915, 70.912),   # fort city in the Thar desert
    "udaipur": (24.580, 73.680),     # lakes + city + hills
    "bharatpur": (27.167, 77.510),   # Keoladeo wetland
}


def cloud_fraction(rgb: np.ndarray) -> float:
    """Heuristic: bright, spectrally flat pixels = cloud/shadow-guarded white."""
    r, g, b = rgb[0], rgb[1], rgb[2]
    mn = np.minimum(np.minimum(r, g), b)
    mx = np.maximum(np.maximum(r, g), b)
    white = (mn > 0.35) & ((mx - mn) < 0.12)
    return float(white.mean())


def read_patch(href: str, lat: float, lon: float) -> np.ndarray | None:
    try:
        with rasterio.open(f"/vsicurl/{href}") as ds:
            xs, ys = transform("EPSG:4326", ds.crs, [lon], [lat])
            row, col = ds.index(xs[0], ys[0])
            win = Window(col - PATCH // 2, row - PATCH // 2, PATCH, PATCH)
            if (
                win.row_off < 0
                or win.col_off < 0
                or win.row_off + PATCH > ds.height
                or win.col_off + PATCH > ds.width
            ):
                return None
            arr = ds.read(1, window=win).astype("float32") / 10_000.0
    except Exception as exc:  # noqa: BLE001 — network/COG failures skip candidate
        print(f"    read failed: {exc}")
        return None
    return np.clip(arr, 0.0, 1.0)


def fetch_site(name: str, lat: float, lon: float) -> dict:
    print(f"[{name}] lat={lat} lon={lon}")
    client = Client.open(STAC_URL)
    search = client.search(
        collections=["sentinel-2-l2a"],
        intersects={"type": "Point", "coordinates": [lon, lat]},
        datetime=DATETIME,
        query={"eo:cloud_cover": {"lt": 25}},
    )
    items = sorted(search.items(), key=lambda i: i.datetime, reverse=True)
    print(f"  candidates: {len(items)}")
    if not items:
        raise RuntimeError(f"{name}: no STAC items")

    for item in items[:10]:
        keys = set(item.assets)
        if not set(ASSET_ORDER) <= keys:
            continue
        scene_cloud = item.properties.get("eo:cloud_cover")
        print(f"  trying {item.id} date={item.datetime.date()} scene_cloud={scene_cloud:.1f}%")
        bands = [read_patch(item.assets[k].href, lat, lon) for k in ASSET_ORDER]
        if any(b is None for b in bands):
            print("    window out of bounds, skipping")
            continue
        arr = np.stack(bands)
        patch_cloud = cloud_fraction(arr)
        print(f"    patch cloud fraction: {patch_cloud:.3f}")
        if patch_cloud > 0.10:
            continue

        np.save(DATA / f"{name}_reflectance.npy", arr)
        preview = (np.moveaxis(arr[:3], 0, -1) * 255).astype("uint8")
        Image.fromarray(preview).save(DATA / f"{name}_preview.png")
        meta = {
            "site": name,
            "lat": lat,
            "lon": lon,
            "item_id": item.id,
            "date": item.datetime.date().isoformat(),
            "scene_cloud_cover_pct": scene_cloud,
            "patch_cloud_fraction": patch_cloud,
            "assets": {k: item.assets[k].href for k in ASSET_ORDER},
            "band_order": ["B04", "B03", "B02", "B08"],
            "scale": "DN/10000 reflectance",
            "size": [PATCH, PATCH],
            "resolution_m": 10,
        }
        (DATA / f"{name}_meta.json").write_text(json.dumps(meta, indent=2))
        print(f"  OK {name}: {item.datetime.date()} patch_cloud={patch_cloud:.3f}")
        return meta

    raise RuntimeError(f"{name}: no clear candidate found")


def main() -> int:
    only = sys.argv[1:] or list(SITES)
    results = {}
    for name in only:
        if name not in SITES:
            continue
        if (DATA / f"{name}_reflectance.npy").exists():
            print(f"[{name}] already fetched, skipping")
            continue
        results[name] = fetch_site(name, *SITES[name])
    print(json.dumps({k: v.get("date") for k, v in results.items()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
