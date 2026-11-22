"""
VHR ingest CLI - NRSC Bhoonidhi to private Supabase Storage XYZ tiles.

Subcommands
-----------
search      List candidate scenes for an AOI as a markdown table (no download).
ingest      Download an online Bhoonidhi delivery, process it, upload tiles.
local-file  Process an already-downloaded zip/GeoTIFF (orders via the portal).

GDAL (osgeo) is imported lazily inside the processing functions so the pure
helpers in pipeline.py and the API client in bhoonidhi.py stay testable on a
machine without GDAL. Secrets (BHOONIDHI_*, SUPABASE_*) are read from the
environment only and never printed.
"""

from __future__ import annotations

import argparse
import json
import math
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any, Sequence
from xml.sax.saxutils import escape as xml_escape

from bhoonidhi import BhoonidhiError, client_from_env
from pipeline import (
    AOI_BUFFER_M,
    PipelineError,
    bbox_of,
    center_lat,
    check_aoi_size,
    check_tile_count,
    format_candidates_markdown,
    load_aoi,
    map_bands,
    max_zoom_for,
    min_zoom_for,
    scene_candidate,
)
from storage import StorageError, SupabaseTiles

DEFAULT_COLLECTIONS = (
    "ResourceSat-2_LISS4-MX70_L2",
    "ResourceSat-2A_LISS4-MX70_L2",
)
LICENSE_NOTE = (
    "NRSC/ISRO Bhoonidhi imagery - government-entity terms; confirm licence "
    "and attribution wording with NRSC before public display."
)
DEFAULT_RESOLUTION_M = 5.8  # LISS-IV MX
QUICKLOOK_MAX_WIDTH = 1024
GDL2TILES_TIMEOUT_S = 1800


class IngestError(RuntimeError):
    """User-facing ingest failure with an actionable message."""


def _progress(message: str) -> None:
    # stderr keeps stdout clean: search emits markdown, ingest emits JSON.
    print(message, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- #
# lazy GDAL                                                                   #
# --------------------------------------------------------------------------- #


def _gdal() -> tuple[Any, Any, Any, Any]:
    try:
        from osgeo import gdal, ogr, osr  # type: ignore
        import numpy  # type: ignore
    except ImportError as exc:
        raise IngestError(
            "GDAL python bindings (osgeo) and numpy are not available - "
            "run inside the vhr Docker image (see vhr/README.md)"
        ) from exc
    gdal.UseExceptions()
    return gdal, ogr, osr, numpy


# --------------------------------------------------------------------------- #
# small helpers                                                               #
# --------------------------------------------------------------------------- #


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _validate_date(text: str, name: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", text or ""):
        raise IngestError(f"{name} must be YYYY-MM-DD, got {text!r}")
    return text


def _datetime_range(start: str, end: str) -> str:
    _validate_date(start, "--start")
    _validate_date(end, "--end")
    if start > end:
        raise IngestError(f"--start ({start}) is after --end ({end})")
    return f"{start}T00:00:00Z/{end}T23:59:59Z"


def sensor_from_collection(collection: str) -> str:
    return collection.replace("_", " ").replace(" L2", "").strip()


def _extract_zip(zip_path: pathlib.Path, dest: pathlib.Path) -> None:
    """Zip-slip-safe extraction: every member must resolve inside dest."""
    dest.mkdir(parents=True, exist_ok=True)
    root = dest.resolve()
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            target = (dest / member.filename).resolve()
            if target != root and root not in target.parents:
                raise IngestError(f"blocked unsafe zip member: {member.filename}")
        archive.extractall(dest)


def _locate_sources(
    source: pathlib.Path, src_dir: pathlib.Path
) -> list[pathlib.Path]:
    if source.is_dir():
        root = source
    elif source.suffix.lower() == ".zip":
        _progress(f"extracting {source.name}...")
        _extract_zip(source, src_dir)
        root = src_dir
    elif source.suffix.lower() in (".tif", ".tiff"):
        return [source]
    else:
        raise IngestError(f"unsupported delivery type: {source}")
    files = sorted(
        p for p in root.rglob("*") if p.suffix.lower() in (".tif", ".tiff")
    )
    if not files:
        raise IngestError("no GeoTIFF found in the delivery")
    return files


def _order_band_files(
    files: Sequence[pathlib.Path],
) -> tuple[list[pathlib.Path], bool]:
    """Natural band order green -> red -> nir by name. Returns (files, known)."""
    tokens = ("green", "red", "nir")
    buckets: dict[str, list[pathlib.Path]] = {token: [] for token in tokens}
    other: list[pathlib.Path] = []
    for file in files:
        name = file.name.lower()
        hit = next((token for token in tokens if token in name), None)
        (buckets[hit] if hit else other).append(file)
    if not other and all(len(buckets[token]) == 1 for token in tokens):
        return [buckets[token][0] for token in tokens], True

    def numeric_key(file: pathlib.Path) -> tuple[int, str]:
        digits = re.findall(r"\d+", file.name)
        return (int(digits[-1]) if digits else 999, file.name.lower())

    return sorted(files, key=numeric_key), False


def _open_checked(path: pathlib.Path) -> Any:
    """Open a GeoTIFF, aborting clearly when georeferencing is missing."""
    gdal, _ogr, _osr, _np = _gdal()
    try:
        dataset = gdal.Open(str(path))
    except RuntimeError as exc:
        raise IngestError(f"cannot open {path}: {exc}") from exc
    if dataset is None:
        raise IngestError(f"cannot open {path}")
    try:
        transform = dataset.GetGeoTransform()
    except RuntimeError:
        transform = None
    projection = dataset.GetProjection() or ""
    default_transform = (0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    if not projection or transform is None or tuple(transform) == default_transform:
        dataset = None
        raise IngestError(
            f"{path} has no georeferencing (projection or geotransform "
            "missing) - aborting"
        )
    if dataset.RasterCount < 1:
        dataset = None
        raise IngestError(f"{path} has no bands")
    return dataset


# --------------------------------------------------------------------------- #
# VRT construction (hand-written - no gdal_translate/buildvrt API risk)       #
# --------------------------------------------------------------------------- #


def _write_vrt(
    entries: Sequence[tuple[str, int]],
    out_path: pathlib.Path,
    grid_ds: Any,
) -> None:
    gdal, _ogr, _osr, _np = _gdal()
    xsize, ysize = grid_ds.RasterXSize, grid_ds.RasterYSize
    srs = grid_ds.GetProjection() or ""
    transform = grid_ds.GetGeoTransform()
    lines = [f'<VRTDataset rasterXSize="{xsize}" rasterYSize="{ysize}">']
    if srs:
        lines.append(f"  <SRS>{xml_escape(srs)}</SRS>")
    lines.append(
        "  <GeoTransform>"
        + ", ".join(repr(float(v)) for v in transform)
        + "</GeoTransform>"
    )
    for index, (path, band_no) in enumerate(entries, start=1):
        source_ds = _open_checked(pathlib.Path(path))
        source_band = source_ds.GetRasterBand(int(band_no))
        data_type = gdal.GetDataTypeName(source_band.DataType)
        nodata = source_band.GetNoDataValue()
        lines.append(f'  <VRTRasterBand dataType="{data_type}" band="{index}">')
        if nodata is not None:
            lines.append(f"    <NoDataValue>{float(nodata)!r}</NoDataValue>")
        lines.append(
            f'    <SourceFilename relativeToVRT="0">{xml_escape(path)}'
            "</SourceFilename>"
        )
        lines.append(f"    <SourceBand>{int(band_no)}</SourceBand>")
        lines.append("  </VRTRasterBand>")
        source_ds = None
    lines.append("</VRTDataset>")
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- #
# cutline: AOI buffered by 200 m (buffer computed in EPSG:3857, metres)       #
# --------------------------------------------------------------------------- #


def _write_cutline(
    aoi_geometry: dict,
    source_srs_wkt: str,
    out_shp: pathlib.Path,
) -> pathlib.Path:
    _gdal, ogr, osr, _np = _gdal()
    wgs = osr.SpatialReference()
    wgs.ImportFromEPSG(4326)
    merc = osr.SpatialReference()
    merc.ImportFromEPSG(3857)
    source_srs = osr.SpatialReference()
    try:
        source_srs.ImportFromWkt(source_srs_wkt)
    except RuntimeError as exc:
        raise IngestError(f"source projection is unusable: {exc}") from exc
    for spatial_ref in (wgs, merc, source_srs):
        spatial_ref.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)

    geometry = ogr.CreateGeometryFromJson(json.dumps(aoi_geometry))
    if geometry is None:
        raise IngestError("AOI is not a geometry OGR can parse")
    geometry_merc = geometry.Clone()
    geometry_merc.Transform(osr.CoordinateTransformation(wgs, merc))
    buffered = geometry_merc.Buffer(AOI_BUFFER_M)
    if buffered is None or buffered.IsEmpty():
        raise IngestError("buffering the AOI by 200 m produced an empty geometry")
    geometry_source = buffered.Clone()
    geometry_source.Transform(osr.CoordinateTransformation(merc, source_srs))
    geometry_source = ogr.ForceToMultiPolygon(geometry_source)

    driver = ogr.GetDriverByName("ESRI Shapefile")
    if out_shp.exists():
        driver.DeleteDataSource(str(out_shp))
    data_source = driver.CreateDataSource(str(out_shp))
    if data_source is None:
        raise IngestError(f"cannot create cutline at {out_shp}")
    layer = data_source.CreateLayer(
        "cutline", srs=source_srs, geom_type=ogr.wkbMultiPolygon
    )
    feature = ogr.Feature(layer.GetLayerDefn())
    feature.SetGeometry(geometry_source)
    layer.CreateFeature(feature)
    feature = None
    data_source = None
    return out_shp


# --------------------------------------------------------------------------- #
# warp -> stretch -> RGBA                                                     #
# --------------------------------------------------------------------------- #


def _warp_to_mercator(
    vrt_path: pathlib.Path,
    cutline_shp: pathlib.Path,
    warped_path: pathlib.Path,
    resolution_m: float,
    latitude: float,
) -> None:
    gdal, _ogr, _osr, _np = _gdal()
    resolution_merc = resolution_m / math.cos(math.radians(latitude))
    _progress(
        f"warping to EPSG:3857 at {resolution_merc:.3f} m/pixel "
        f"(AOI + {AOI_BUFFER_M:.0f} m clip)..."
    )
    try:
        result = gdal.Warp(
            str(warped_path),
            str(vrt_path),
            options=gdal.WarpOptions(
                format="GTiff",
                dstSRS="EPSG:3857",
                outputType=gdal.GDT_Float32,
                xRes=resolution_merc,
                yRes=resolution_merc,
                resampleAlg="bilinear",
                cutlineDSName=str(cutline_shp),
                cropToCutline=True,
                dstAlpha=True,
                creationOptions=["COMPRESS=DEFLATE", "TILED=YES"],
            ),
        )
    except RuntimeError as exc:
        raise IngestError(f"warp failed: {exc}") from exc
    if result is None:
        raise IngestError("warp failed with no output")
    result = None


def _stretch_to_rgba(
    warped_path: pathlib.Path,
    rgba_path: pathlib.Path,
) -> list[list[float]]:
    """2-98 percentile stretch inside the AOI -> 8-bit RGBA (transparent
    outside the clipped data). Returns per-band [low, high] percentiles."""
    gdal, _ogr, _osr, np = _gdal()
    _progress("stretching bands to 8-bit RGBA (2-98 percentile)...")
    dataset = _open_checked(warped_path)
    band_total = dataset.RasterCount
    if band_total < 2:
        dataset = None
        raise IngestError("warped output has no alpha band")
    planes = [
        dataset.GetRasterBand(index).ReadAsArray()
        for index in range(1, band_total + 1)
    ]
    alpha = planes[-1]
    source_planes = planes[:-1]
    valid = np.asarray(alpha) > 0
    if not valid.any():
        dataset = None
        raise IngestError("no valid pixels inside the AOI after clipping")

    stretched: list[Any] = []
    percentiles: list[list[float]] = []
    for plane in source_planes:
        values = np.asarray(plane, dtype=np.float32)
        sample = values[valid]
        sample = sample[np.isfinite(sample)]
        if sample.size == 0:
            dataset = None
            raise IngestError("a band has no finite pixels inside the AOI")
        low, high = (float(v) for v in np.percentile(sample, [2.0, 98.0]))
        if not math.isfinite(low):
            low = 0.0
        if not math.isfinite(high) or high <= low:
            high = low + 1.0
        percentiles.append([low, high])
        values = np.nan_to_num(values, nan=low, posinf=high, neginf=low)
        scaled = (values - low) / (high - low) * 255.0
        np.clip(scaled, 0, 255, out=scaled)
        stretched.append(scaled.astype(np.uint8))
    while len(stretched) < 3:
        stretched.append(stretched[0])  # grayscale -> grey RGB
    alpha_byte = np.where(valid, 255, 0).astype(np.uint8)

    width, height = dataset.RasterXSize, dataset.RasterYSize
    geotransform = dataset.GetGeoTransform()
    projection = dataset.GetProjection() or ""
    dataset = None

    driver = gdal.GetDriverByName("GTiff")
    output = driver.Create(
        str(rgba_path),
        width,
        height,
        4,
        gdal.GDT_Byte,
        options=["COMPRESS=DEFLATE", "TILED=YES"],
    )
    if output is None:
        raise IngestError(f"cannot create {rgba_path}")
    output.SetGeoTransform(geotransform)
    if projection:
        output.SetProjection(projection)
    interpretations = [
        gdal.GCI_RedBand,
        gdal.GCI_GreenBand,
        gdal.GCI_BlueBand,
        gdal.GCI_AlphaBand,
    ]
    for index in range(4):
        band = output.GetRasterBand(index + 1)
        band.WriteArray(stretched[index] if index < 3 else alpha_byte)
        band.SetColorInterpretation(interpretations[index])
    output.FlushCache()
    output = None
    return percentiles


def _write_quicklook(rgba_path: pathlib.Path, out_path: pathlib.Path) -> None:
    gdal, _ogr, _osr, _np = _gdal()
    dataset = _open_checked(rgba_path)
    width = dataset.RasterXSize
    step = max(1, math.ceil(width / QUICKLOOK_MAX_WIDTH))
    planes = [
        dataset.GetRasterBand(index).ReadAsArray()[::step, ::step]
        for index in (1, 2, 3)
    ]
    dataset = None
    sample_height, sample_width = planes[0].shape
    memory = gdal.GetDriverByName("MEM").Create(
        "", sample_width, sample_height, 3, gdal.GDT_Byte
    )
    for index, plane in enumerate(planes, start=1):
        band = memory.GetRasterBand(index)
        band.WriteArray(plane)
        band.SetColorInterpretation(
            [gdal.GCI_RedBand, gdal.GCI_GreenBand, gdal.GCI_BlueBand][index - 1]
        )
    try:
        gdal.GetDriverByName("JPEG").CreateCopy(
            str(out_path), memory, options=["QUALITY=85"]
        )
    except RuntimeError as exc:
        memory = None
        raise IngestError(f"quicklook failed: {exc}") from exc
    memory = None


# --------------------------------------------------------------------------- #
# tiles                                                                       #
# --------------------------------------------------------------------------- #


def run_gdal2tiles(
    tif_path: pathlib.Path, out_dir: pathlib.Path,
    min_zoom: int, max_zoom: int,
) -> None:
    """gdal2tiles as a subprocess - module form first, script form second."""
    arguments = [
        "-z", f"{min_zoom}-{max_zoom}",
        "--xyz",
        "-w", "none",
        "-p", "mercator",
        str(tif_path),
        str(out_dir),
    ]
    attempts = (
        [sys.executable, "-m", "osgeo.utils.gdal2tiles"],
        ["gdal2tiles.py"],
        ["gdal2tiles"],
    )
    errors: list[str] = []
    for command in attempts:
        try:
            process = subprocess.run(
                command + arguments,
                capture_output=True,
                text=True,
                errors="replace",
                timeout=GDL2TILES_TIMEOUT_S,
            )
        except (FileNotFoundError, OSError) as exc:
            errors.append(f"{' '.join(command)}: {exc.__class__.__name__}")
            continue
        except subprocess.TimeoutExpired:
            raise IngestError("gdal2tiles timed out after 30 minutes") from None
        if process.returncode == 0:
            return
        tail = (process.stderr or process.stdout or "").strip()[-2000:]
        errors.append(f"{' '.join(command)} rc={process.returncode}: {tail}")
    raise IngestError("gdal2tiles failed:\n" + "\n".join(errors))


def _list_tiles(tiles_dir: pathlib.Path) -> list[pathlib.Path]:
    return [
        path
        for path in tiles_dir.rglob("*.png")
        if len(path.relative_to(tiles_dir).parts) == 3
    ]


# --------------------------------------------------------------------------- #
# scene processing                                                            #
# --------------------------------------------------------------------------- #


def process_delivery(
    source: pathlib.Path,
    aoi: dict,
    *,
    collection: str,
    item_id: str,
    bands_override: str | None,
    resolution_m: float,
    work_dir: pathlib.Path,
    dry_run: bool,
    sensor: str,
    acquired_at: str,
) -> dict:
    _gdal()  # fail fast when GDAL/numpy are missing
    if resolution_m <= 0:
        raise IngestError(f"--resolution-m must be positive, got {resolution_m}")
    area = check_aoi_size(aoi)
    work_dir.mkdir(parents=True, exist_ok=True)
    src_dir = work_dir / "src"
    proc_dir = work_dir / "proc"
    proc_dir.mkdir(parents=True, exist_ok=True)

    files = _locate_sources(source, src_dir)
    if len(files) == 1:
        grid_ds = _open_checked(files[0])
        band_count = int(grid_ds.RasterCount)
        ordered: list[pathlib.Path] = files
        names_known = True
        grid_ds = None
    else:
        ordered, names_known = _order_band_files(files)
        band_count = len(ordered)
        if not names_known:
            print(
                "warning: cannot identify green/red/nir from file names; "
                "using numeric/alphabetical order - verify band order",
                file=sys.stderr,
                flush=True,
            )
        for file in ordered:
            probe = _open_checked(file)
            probe = None
    mapping = map_bands(band_count, bands_override)

    if len(files) == 1:
        entries = [(str(files[0]), int(band)) for band in mapping.bands]
        grid_path = files[0]
    else:
        entries = [
            (str(ordered[int(band) - 1]), 1) for band in mapping.bands
        ]
        grid_path = ordered[0]

    grid_ds = _open_checked(grid_path)
    vrt_path = proc_dir / "stack.vrt"
    _write_vrt(entries, vrt_path, grid_ds)
    source_srs_wkt = grid_ds.GetProjection() or ""
    grid_ds = None

    cutline_shp = _write_cutline(aoi, source_srs_wkt, proc_dir / "cutline.shp")
    warped_path = proc_dir / "warped.tif"
    latitude = center_lat(aoi)
    _warp_to_mercator(vrt_path, cutline_shp, warped_path, resolution_m, latitude)

    rgba_path = proc_dir / "rgba.tif"
    percentiles = _stretch_to_rgba(warped_path, rgba_path)

    min_zoom = min_zoom_for(max_zoom_for(resolution_m, latitude))
    max_zoom = max_zoom_for(resolution_m, latitude)

    quicklook_path = proc_dir / "quicklook.jpg"
    _write_quicklook(rgba_path, quicklook_path)

    tiles_dir = proc_dir / "tiles"
    if tiles_dir.exists():
        shutil.rmtree(tiles_dir)
    tiles_dir.mkdir(parents=True)
    _progress(f"generating XYZ tiles z{min_zoom}-z{max_zoom}...")
    run_gdal2tiles(rgba_path, tiles_dir, min_zoom, max_zoom)
    tiles = _list_tiles(tiles_dir)
    if not tiles:
        raise IngestError("gdal2tiles produced no tiles")
    check_tile_count(len(tiles))
    size_bytes = sum(path.stat().st_size for path in tiles)

    scene_id = str(uuid.uuid4())
    box = bbox_of(aoi)
    if box is None:
        raise IngestError("AOI has no bounding box")
    min_lng, min_lat, max_lng, max_lat = box
    row: dict[str, Any] = {
        "id": scene_id,
        "source": "nrsc-bhoonidhi",
        "collection": collection,
        "item_id": item_id,
        "sensor": sensor,
        "acquired_at": acquired_at,
        "resolution_m": resolution_m,
        "bands": {
            "mapping": mapping.kind,
            "selected": [int(band) for band in mapping.bands],
            "source_band_count": band_count,
            "override": bands_override,
        },
        "stretch": {
            "method": "percentile-2-98",
            "percentiles": percentiles,
        },
        "min_lng": min_lng,
        "min_lat": min_lat,
        "max_lng": max_lng,
        "max_lat": max_lat,
        "footprint": aoi,
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
        "storage_path": scene_id,
        "tile_count": len(tiles),
        "size_bytes": size_bytes,
        "license_note": LICENSE_NOTE,
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    uploaded = False
    if dry_run:
        _progress(f"dry run: skipping upload of {len(tiles)} tiles")
    else:
        client = SupabaseTiles.from_env(
            log=lambda message: _progress(message)
        )
        _progress(f"uploading {len(tiles)} tiles to bucket vhr-tiles...")
        uploaded_count, uploaded_bytes = client.upload_tiles(
            scene_id, str(tiles_dir)
        )
        if quicklook_path.exists():
            client.upload_bytes(
                f"{scene_id}/quicklook.jpg",
                quicklook_path.read_bytes(),
                content_type="image/jpeg",
            )
        row["tile_count"] = uploaded_count
        row["size_bytes"] = uploaded_bytes
        client.insert_scene(row)
        uploaded = True
        _progress(f"scene {scene_id} stored ({uploaded_count} tiles)")

    return {
        "scene_id": scene_id,
        "item_id": item_id,
        "collection": collection,
        "sensor": sensor,
        "acquired_at": acquired_at,
        "resolution_m": resolution_m,
        "bands": row["bands"],
        "stretch": row["stretch"],
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
        "tile_count": row["tile_count"],
        "size_bytes": row["size_bytes"],
        "aoi_area_km2": area,
        "uploaded": uploaded,
        "storage_path": scene_id,
        "quicklook": str(quicklook_path),
        "work_dir": str(work_dir),
    }


# --------------------------------------------------------------------------- #
# commands                                                                    #
# --------------------------------------------------------------------------- #


def _load_aoi(text: str) -> dict:
    return load_aoi(text)


def cmd_search(args: argparse.Namespace) -> int:
    aoi = _load_aoi(args.aoi)
    area = check_aoi_size(aoi)
    collections = list(args.collection) if args.collection else list(
        DEFAULT_COLLECTIONS
    )
    datetime_range = _datetime_range(args.start, args.end)
    with client_from_env() as client:
        features = client.search(
            collections=collections,
            datetime_range=datetime_range,
            intersects=aoi,
            limit=args.limit,
            online_only=not args.include_offline,
        )
    rows = [scene_candidate(feature, aoi) for feature in features]
    rows.sort(key=lambda row: (row["online"] != "Y", -row["coverage"]))
    print(format_candidates_markdown(rows, aoi_area=area))
    return 0


def _pick_best(pairs: list[tuple[dict, dict]]) -> tuple[dict, dict]:
    if not pairs:
        raise IngestError(
            "no scenes matched the AOI/date range - try a wider range or "
            "order the scene through the portal's Browse & Order"
        )
    row, _feature = pairs[0]
    if row["online"] == "N":
        raise IngestError(
            "best candidate is not on online storage - order it through the "
            "portal's Browse & Order, then re-run with local-file"
        )
    if row["coverage"] <= 0:
        raise IngestError("no candidate covers any of the AOI")
    return pairs[0]


def cmd_ingest(args: argparse.Namespace) -> int:
    aoi = _load_aoi(args.aoi)
    area = check_aoi_size(aoi)
    collections = list(args.collection) if args.collection else list(
        DEFAULT_COLLECTIONS
    )
    work_dir = pathlib.Path(args.work_dir) if args.work_dir else pathlib.Path(
        tempfile.mkdtemp(prefix="vhr-ingest-")
    )
    download_path = work_dir / "delivery.zip"
    work_dir.mkdir(parents=True, exist_ok=True)

    if args.item_id:
        if len(collections) != 1:
            raise IngestError("pass exactly one --collection with --item-id")
        collection = collections[0]
        with client_from_env() as client:
            feature = client.get_item(collection, args.item_id)
            row = scene_candidate(feature, aoi)
            row["item_id"] = args.item_id
            _progress(
                f"downloading {collection}/{args.item_id} "
                f"(AOI covered {row['coverage']:.1f}%)..."
            )
            client.download(args.item_id, collection, str(download_path))
        chosen = row
    else:
        datetime_range = _datetime_range(args.start, args.end)
        with client_from_env() as client:
            features = client.search(
                collections=collections,
                datetime_range=datetime_range,
                intersects=aoi,
                limit=args.limit,
                online_only=not args.include_offline,
            )
        pairs = sorted(
            ((scene_candidate(feature, aoi), feature) for feature in features),
            key=lambda pair: (pair[0]["online"] != "Y", -pair[0]["coverage"]),
        )
        print(
            format_candidates_markdown(
                [pair[0] for pair in pairs], aoi_area=area
            ),
            flush=True,
        )
        chosen, feature = _pick_best(pairs)
        collection = chosen["collection"] or collections[0]
        with client_from_env() as client:
            _progress(
                f"downloading {collection}/{chosen['item_id']} "
                f"(AOI covered {chosen['coverage']:.1f}%)..."
            )
            client.download(chosen["item_id"], collection, str(download_path))

    summary = process_delivery(
        download_path,
        aoi,
        collection=collection,
        item_id=chosen["item_id"],
        bands_override=args.bands,
        resolution_m=args.resolution_m,
        work_dir=work_dir,
        dry_run=args.dry_run,
        sensor=args.sensor or sensor_from_collection(collection),
        acquired_at=chosen["date"] or _today(),
    )
    print(json.dumps(summary, indent=2))
    return 0


def cmd_local_file(args: argparse.Namespace) -> int:
    aoi = _load_aoi(args.aoi)
    check_aoi_size(aoi)
    source = pathlib.Path(args.file)
    if not source.exists():
        raise IngestError(f"file not found: {source}")
    if not args.collection or not args.item_id:
        raise IngestError(
            "--collection and --item-id are required for local-file "
            "(the portal order id becomes the catalogue entry)"
        )
    acquired = _validate_date(args.date, "--date") if args.date else _today()
    work_dir = pathlib.Path(args.work_dir) if args.work_dir else source.parent
    summary = process_delivery(
        source,
        aoi,
        collection=args.collection,
        item_id=args.item_id,
        bands_override=args.bands,
        resolution_m=args.resolution_m,
        work_dir=work_dir / f"vhr-local-{args.item_id}",
        dry_run=args.dry_run,
        sensor=args.sensor or sensor_from_collection(args.collection),
        acquired_at=acquired,
    )
    print(json.dumps(summary, indent=2))
    return 0


# --------------------------------------------------------------------------- #
# argparse / main                                                             #
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ingest.py",
        description=(
            "NRSC Bhoonidhi VHR ingest: search, download, tile and upload "
            "high-resolution scenes to private Supabase Storage. Secrets come "
            "from the environment only (BHOONIDHI_USER, BHOONIDHI_PASSWORD, "
            "SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)."
        ),
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_common(sub: argparse.ArgumentParser) -> None:
        sub.add_argument(
            "--aoi",
            required=True,
            help="path to AOI GeoJSON, or inline GeoJSON text",
        )
        sub.add_argument(
            "--bands",
            default=None,
            help="explicit band mapping R,G,B (e.g. 4,3,2); 3-band sources "
            "default to false colour (NIR,red,green), 1-band to grayscale",
        )
        sub.add_argument(
            "--resolution-m",
            type=float,
            default=DEFAULT_RESOLUTION_M,
            help=f"ground resolution in metres (default {DEFAULT_RESOLUTION_M})",
        )
        sub.add_argument("--work-dir", default=None, help="working directory")
        sub.add_argument(
            "--dry-run",
            action="store_true",
            help="process and tile, but skip the storage upload and DB insert",
        )

    search = subparsers.add_parser(
        "search", help="list candidate scenes as a markdown table"
    )
    search.add_argument("--aoi", required=True, help="AOI GeoJSON path/text")
    search.add_argument("--start", required=True, help="YYYY-MM-DD")
    search.add_argument("--end", required=True, help="YYYY-MM-DD")
    search.add_argument(
        "--collection",
        action="append",
        help="STAC collection id (repeatable; defaults to the LISS-4 pair)",
    )
    search.add_argument("--limit", type=int, default=500, help="page size")
    search.add_argument(
        "--include-offline",
        action="store_true",
        help="also list items that are not directly downloadable",
    )
    search.set_defaults(func=cmd_search)

    ingest = subparsers.add_parser(
        "ingest", help="download, process and upload one scene"
    )
    add_common(ingest)
    ingest.add_argument("--start", help="YYYY-MM-DD (required without --item-id)")
    ingest.add_argument("--end", help="YYYY-MM-DD (required without --item-id)")
    ingest.add_argument(
        "--collection",
        action="append",
        help="STAC collection id (repeatable; defaults to the LISS-4 pair)",
    )
    ingest.add_argument(
        "--item-id",
        default=None,
        help="skip the search and download this exact item",
    )
    ingest.add_argument("--limit", type=int, default=500, help="search page size")
    ingest.add_argument(
        "--include-offline",
        action="store_true",
        help="consider items that are not directly downloadable",
    )
    ingest.add_argument("--sensor", default=None, help="sensor label override")
    ingest.set_defaults(func=cmd_ingest)

    local = subparsers.add_parser(
        "local-file",
        help="process an already-downloaded zip/GeoTIFF (portal orders)",
    )
    add_common(local)
    local.add_argument(
        "--file", required=True, help="path to the delivery .zip or .tif"
    )
    local.add_argument("--collection", required=True, help="catalogue collection")
    local.add_argument("--item-id", required=True, help="catalogue item id")
    local.add_argument("--date", default=None, help="acquisition date YYYY-MM-DD")
    local.add_argument("--sensor", default=None, help="sensor label override")
    local.set_defaults(func=cmd_local_file)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)
    if args.command == "ingest" and not args.item_id:
        if not args.start or not args.end:
            parser.error("ingest without --item-id requires --start and --end")
    try:
        return int(args.func(args))
    except (BhoonidhiError, StorageError, PipelineError, IngestError) as exc:
        print(f"error: {exc}", file=sys.stderr, flush=True)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr, flush=True)
        return 130


if __name__ == "__main__":
    sys.exit(main())
