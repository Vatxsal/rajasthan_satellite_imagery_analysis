"""
Pure helpers for the VHR ingest — no GDAL, no network, fully unit-tested.

Covers: AOI loading/area guard, grid-sampled footprint coverage, false-colour
band mapping, slippy-map zoom computation and the per-scene tile ceiling.
"""

from __future__ import annotations

import json
import math
import os
from typing import Any, NamedTuple, Sequence

# Hard ceilings from the ingest spec.
TILE_LIMIT = 3000
MAX_AOI_KM2 = 400.0
AOI_BUFFER_M = 200.0

# WGS84 mean radius (m) for the spherical area approximation.
EARTH_RADIUS_M = 6371008.8
# Web-Mercator latitude clamp (gdal2tiles / slippy maps).
WEB_MERCATOR_MAX_LAT = 85.05112878


class PipelineError(RuntimeError):
    """User-facing ingest problem with a clear, actionable message."""


# --------------------------------------------------------------------------- #
# AOI loading & area                                                          #
# --------------------------------------------------------------------------- #


def load_aoi(path_or_json: str) -> dict:
    """AOI geometry from a file path or inline GeoJSON text. Accepts a bare
    geometry, a Feature, or a FeatureCollection (first polygonal feature)."""
    text = path_or_json
    if os.path.exists(path_or_json):
        try:
            with open(path_or_json, "r", encoding="utf-8") as handle:
                text = handle.read()
        except OSError as exc:
            raise PipelineError(f"cannot read AOI file: {exc}") from exc
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise PipelineError(
            f"AOI is neither an existing file path nor valid JSON: {exc}"
        ) from exc
    return geometry_of(data)


def geometry_of(data: Any) -> dict:
    if not isinstance(data, dict):
        raise PipelineError("AOI must be a GeoJSON object")
    kind = data.get("type")
    if kind in ("Polygon", "MultiPolygon"):
        return data
    if kind == "Feature":
        geom = data.get("geometry")
        if isinstance(geom, dict) and geom.get("type") in ("Polygon", "MultiPolygon"):
            return geom
    if kind == "FeatureCollection":
        for feature in data.get("features") or []:
            if isinstance(feature, dict):
                try:
                    return geometry_of(feature)
                except PipelineError:
                    continue
    raise PipelineError("AOI must contain a Polygon or MultiPolygon geometry")


def polygons_of(geometry: dict | None) -> list[list[list[list[float]]]]:
    """Normalise to a list of polygons, each a list of rings (exterior first)."""
    if not isinstance(geometry, dict):
        return []
    kind = geometry.get("type")
    coords = geometry.get("coordinates")
    if kind == "Polygon" and isinstance(coords, list):
        return [_clean_rings(coords)]
    if kind == "MultiPolygon" and isinstance(coords, list):
        return [_clean_rings(poly) for poly in coords if isinstance(poly, list)]
    return []


def _clean_rings(rings: Any) -> list[list[list[float]]]:
    cleaned: list[list[list[float]]] = []
    for ring in rings:
        if not isinstance(ring, list):
            continue
        points = [
            [float(pt[0]), float(pt[1])]
            for pt in ring
            if isinstance(pt, (list, tuple)) and len(pt) >= 2
        ]
        if len(points) >= 4:
            cleaned.append(points)
    return cleaned


def _ring_area_km2(ring: Sequence[Sequence[float]]) -> float:
    """Spherical polygon area (Chamberlain–Duquette, as turf.js uses)."""
    points = list(ring)
    if points and points[0] != points[-1]:
        points.append(points[0])
    total = 0.0
    for i in range(len(points) - 1):
        lon1, lat1 = points[i][0], points[i][1]
        lon2, lat2 = points[i + 1][0], points[i + 1][1]
        total += math.radians(lon2 - lon1) * (
            2.0 + math.sin(math.radians(lat1)) + math.sin(math.radians(lat2))
        )
    return abs(total) * EARTH_RADIUS_M * EARTH_RADIUS_M / 2.0 / 1_000_000.0


def aoi_area_km2(geometry: dict | None) -> float:
    total = 0.0
    for polygon in polygons_of(geometry):
        if not polygon:
            continue
        total += _ring_area_km2(polygon[0])
        for hole in polygon[1:]:
            total -= _ring_area_km2(hole)
    return total


def check_aoi_size(geometry: dict) -> float:
    """Reject AOIs over 400 km² (tile/runtime guard). Returns the area."""
    area = aoi_area_km2(geometry)
    if area > MAX_AOI_KM2:
        raise PipelineError(
            f"AOI is {area:.1f} km² — over the {MAX_AOI_KM2:.0f} km² ingest "
            "limit; draw a smaller area"
        )
    if area <= 0:
        raise PipelineError("AOI has zero area")
    return area


def bbox_of(geometry: dict | None) -> tuple[float, float, float, float] | None:
    """(min_lng, min_lat, max_lng, max_lat) or None."""
    points: list[tuple[float, float]] = []
    for polygon in polygons_of(geometry):
        for ring in polygon:
            points.extend((pt[0], pt[1]) for pt in ring)
    if not points:
        return None
    lons = [p[0] for p in points]
    lats = [p[1] for p in points]
    return (min(lons), min(lats), max(lons), max(lats))


def center_lat(geometry: dict | None) -> float:
    box = bbox_of(geometry)
    if box is None:
        return 0.0
    return (box[1] + box[3]) / 2.0


# --------------------------------------------------------------------------- #
# Footprint coverage (grid sampling — works for any shape, no shapely)        #
# --------------------------------------------------------------------------- #


def _point_in_ring(x: float, y: float, ring: Sequence[Sequence[float]]) -> bool:
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def _point_in_polys(x: float, y: float, polys: list[list[list[list[float]]]]) -> bool:
    for polygon in polys:
        if not polygon:
            continue
        if _point_in_ring(x, y, polygon[0]):
            in_hole = any(_point_in_ring(x, y, hole) for hole in polygon[1:])
            if not in_hole:
                return True
    return False


def coverage_percent(
    footprint: dict | None,
    aoi: dict,
    *,
    grid: int = 100,
) -> float:
    """Percent of AOI grid points that fall inside the item footprint."""
    aoi_polys = polygons_of(aoi)
    fp_polys = polygons_of(footprint)
    if not aoi_polys or not fp_polys:
        return 0.0
    box = bbox_of(aoi)
    if box is None:
        return 0.0
    minx, miny, maxx, maxy = box
    width = (maxx - minx) / grid
    height = (maxy - miny) / grid
    if width <= 0 or height <= 0:
        # Degenerate bbox: single sample at the centre.
        points = [((minx + maxx) / 2.0, (miny + maxy) / 2.0)]
    else:
        points = [
            (minx + (ix + 0.5) * width, miny + (iy + 0.5) * height)
            for ix in range(grid)
            for iy in range(grid)
        ]
    inside_aoi = 0
    inside_both = 0
    for x, y in points:
        if _point_in_polys(x, y, aoi_polys):
            inside_aoi += 1
            if _point_in_polys(x, y, fp_polys):
                inside_both += 1
    if inside_aoi == 0:
        return 0.0
    return 100.0 * inside_both / inside_aoi


# --------------------------------------------------------------------------- #
# Band mapping                                                                #
# --------------------------------------------------------------------------- #


class BandMapping(NamedTuple):
    kind: str  # "rgb" | "gray"
    bands: tuple[int, ...]  # rgb → (R, G, B) 1-based; gray → (band,)


def parse_bands_override(value: str | None) -> tuple[int, int, int] | None:
    if value is None or not str(value).strip():
        return None
    parts = [part.strip() for part in str(value).split(",")]
    if len(parts) != 3:
        raise PipelineError(
            "--bands must list exactly three band numbers, e.g. --bands 4,3,2"
        )
    try:
        bands = tuple(int(part) for part in parts)
    except ValueError:
        raise PipelineError(
            f"--bands must be three integers, got {value!r}"
        ) from None
    if any(band < 1 for band in bands):
        raise PipelineError(f"--bands must be 1-based, got {value!r}")
    return bands  # type: ignore[return-value]


def map_bands(band_count: int, override: str | None = None) -> BandMapping:
    """3 bands → false colour (R=NIR, G=red, B=green for the delivered
    green,red,NIR order); 1 band → grayscale; anything else needs --bands."""
    if band_count < 1:
        raise PipelineError("source has no bands")
    explicit = parse_bands_override(override)
    if explicit:
        for band in explicit:
            if band > band_count:
                raise PipelineError(
                    f"--bands references band {band} but the source has "
                    f"{band_count} band(s)"
                )
        return BandMapping("rgb", explicit)
    if band_count == 1:
        return BandMapping("gray", (1,))
    if band_count == 3:
        # Delivered order: green(1), red(2), NIR(3) → false colour composite.
        return BandMapping("rgb", (3, 2, 1))
    raise PipelineError(
        f"{band_count} bands need an explicit --bands R,G,B override "
        "(e.g. --bands 4,3,2 for a 4-band stack)"
    )


# --------------------------------------------------------------------------- #
# Zoom & tile limits                                                          #
# --------------------------------------------------------------------------- #


def max_zoom_for(resolution_m: float, latitude: float) -> int:
    """round(log2(156543.03 · cos(lat) / resolution_m)) — the slippy-map
    zoom whose ground resolution matches the sensor."""
    if resolution_m <= 0:
        raise PipelineError(f"resolution must be positive, got {resolution_m}")
    lat = max(-WEB_MERCATOR_MAX_LAT, min(WEB_MERCATOR_MAX_LAT, latitude))
    return int(round(math.log2(156543.03 * math.cos(math.radians(lat)) / resolution_m)))


def min_zoom_for(max_zoom: int) -> int:
    """max zoom − 4, never below 11."""
    return max(11, max_zoom - 4)


def check_tile_count(count: int) -> int:
    if count > TILE_LIMIT:
        raise PipelineError(
            f"scene would produce {count} tiles — over the {TILE_LIMIT} tile "
            "limit; use a smaller AOI or a coarser resolution"
        )
    return count


# --------------------------------------------------------------------------- #
# Search candidate rows (defensive property reads)                            #
# --------------------------------------------------------------------------- #

_DATE_LIKE_KEYS = (
    "datetime",
    "start_datetime",
    "acquired",
    "acquired_at",
    "date",
    "time",
    "level1time",
)


def _first_string(props: dict, keys: Sequence[str]) -> str:
    for key in keys:
        value = props.get(key)
        if isinstance(value, str) and value.strip():
            text = value.strip()
            # Prefer the YYYY-MM-DD prefix when the value is a full timestamp.
            if len(text) >= 10 and text[4] == "-" and text[7] == "-":
                return text[:10]
            return text
    return ""


def online_flag(props: dict) -> str:
    """Y / N / best-effort — property names are not fully documented."""
    value = props.get("Online", props.get("online"))
    if value is None:
        return "?"
    if isinstance(value, bool):
        return "Y" if value else "N"
    text = str(value).strip().upper()
    if text in ("Y", "YES", "TRUE", "1"):
        return "Y"
    if text in ("N", "NO", "FALSE", "0"):
        return "N"
    return text[:8]


def property_keys(feature: dict) -> list[str]:
    props = feature.get("properties")
    if isinstance(props, dict):
        return sorted(str(key) for key in props.keys())
    return []


def scene_candidate(feature: dict, aoi: dict) -> dict:
    props = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
    return {
        "item_id": str(feature.get("id") or props.get("id") or ""),
        "collection": str(feature.get("collection") or props.get("collection") or ""),
        "date": _first_string(props, _DATE_LIKE_KEYS),
        "coverage": coverage_percent(feature.get("geometry"), aoi),
        "online": online_flag(props),
    }


def format_candidates_markdown(rows: Sequence[dict], *, aoi_area: float) -> str:
    lines = [
        "### Bhoonidhi candidate scenes",
        "",
        f"AOI area: {aoi_area:.2f} km² · matched {len(rows)} scene(s)",
        "",
        "| Item id | Collection | Date | AOI covered | Online |",
        "| --- | --- | --- | --- | --- |",
    ]
    for row in rows:
        lines.append(
            f"| {row['item_id']} | {row['collection']} | {row['date'] or '—'} "
            f"| {row['coverage']:.1f}% | {row['online']} |"
        )
    if not rows:
        lines.append("| — | — | — | — | no scenes matched |")
    lines.append("")
    return "\n".join(lines)
