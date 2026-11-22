"""CLI-level tests for ingest.py — pure helpers only; GDAL is never imported."""

from __future__ import annotations

import json
import zipfile

import pytest

from ingest import (
    DEFAULT_COLLECTIONS,
    IngestError,
    _datetime_range,
    _extract_zip,
    _list_tiles,
    _locate_sources,
    _order_band_files,
    _validate_date,
    build_parser,
    main,
    sensor_from_collection,
)

SQUARE = {
    "type": "Polygon",
    "coordinates": [[[74.0, 26.0], [74.1, 26.0], [74.1, 26.1],
                     [74.0, 26.1], [74.0, 26.0]]],
}
AOI_JSON = json.dumps(SQUARE)


# --------------------------------------------------------------------------- #
# argument handling                                                           #
# --------------------------------------------------------------------------- #


def test_datetime_range_valid():
    assert _datetime_range("2024-01-01", "2024-01-31") == (
        "2024-01-01T00:00:00Z/2024-01-31T23:59:59Z"
    )


@pytest.mark.parametrize(
    ("start", "end"),
    [("2024-13-01", "2024-01-31"), ("2024-01-01", "01-31-2024"),
     ("2024-02-01", "2024-01-01")],
)
def test_datetime_range_rejects_bad_input(start, end):
    with pytest.raises(IngestError):
        _datetime_range(start, end)


def test_validate_date():
    assert _validate_date("2024-05-01", "--date") == "2024-05-01"
    with pytest.raises(IngestError, match="YYYY-MM-DD"):
        _validate_date("May 1 2024", "--date")


def test_sensor_from_collection():
    assert sensor_from_collection("ResourceSat-2_LISS4-MX70_L2") == (
        "ResourceSat-2 LISS4-MX70"
    )


def test_parser_exposes_three_subcommands():
    parser = build_parser()
    args = parser.parse_args(
        ["search", "--aoi", AOI_JSON, "--start", "2024-01-01",
         "--end", "2024-01-31"]
    )
    assert args.command == "search"
    assert args.aoi == AOI_JSON

    args = parser.parse_args(
        ["ingest", "--aoi", AOI_JSON, "--start", "2024-01-01",
         "--end", "2024-01-31", "--item-id", "x"]
    )
    assert args.command == "ingest"
    assert args.resolution_m == pytest.approx(5.8)
    assert args.dry_run is False

    args = parser.parse_args(
        ["local-file", "--aoi", AOI_JSON, "--file", "a.zip",
         "--collection", "C", "--item-id", "i"]
    )
    assert args.command == "local-file"


def test_ingest_without_item_id_requires_dates():
    with pytest.raises(SystemExit):
        main(["ingest", "--aoi", AOI_JSON])


def test_search_without_dates_is_usage_error():
    with pytest.raises(SystemExit):
        main(["search", "--aoi", AOI_JSON])


def test_no_password_arguments_exist():
    # secrets must come from the environment only
    parser = build_parser()
    dests: list[str] = []
    for action in parser._actions:
        if action.__class__.__name__ == "_SubParsersAction":
            for sub in action.choices.values():
                dests.extend(a.dest for a in sub._actions)
        else:
            dests.append(action.dest)
    assert dests
    for dest in dests:
        assert "password" not in dest
        assert "secret" not in dest
        assert dest != "user"


# --------------------------------------------------------------------------- #
# main error surfacing                                                        #
# --------------------------------------------------------------------------- #


def test_main_reports_missing_credentials(monkeypatch, capsys):
    monkeypatch.delenv("BHOONIDHI_USER", raising=False)
    monkeypatch.delenv("BHOONIDHI_PASSWORD", raising=False)
    code = main(
        ["search", "--aoi", AOI_JSON, "--start", "2024-01-01",
         "--end", "2024-01-31"]
    )
    assert code == 1
    captured = capsys.readouterr()
    assert "BHOONIDHI_USER" in captured.err
    assert "BHOONIDHI_PASSWORD" in captured.err


def test_main_reports_bad_aoi(monkeypatch, capsys):
    monkeypatch.setenv("BHOONIDHI_USER", "u")
    monkeypatch.setenv("BHOONIDHI_PASSWORD", "p")
    code = main(
        ["search", "--aoi", "not geojson", "--start", "2024-01-01",
         "--end", "2024-01-31"]
    )
    assert code == 1
    assert "error:" in capsys.readouterr().err


def test_default_collections_are_the_liss4_pair():
    assert DEFAULT_COLLECTIONS == (
        "ResourceSat-2_LISS4-MX70_L2",
        "ResourceSat-2A_LISS4-MX70_L2",
    )


# --------------------------------------------------------------------------- #
# delivery inspection (no GDAL needed)                                        #
# --------------------------------------------------------------------------- #


def test_order_band_files_by_name(tmp_path):
    nir = tmp_path / "scene_nir.tif"
    green = tmp_path / "scene_green.tif"
    red = tmp_path / "scene_red.tif"
    for path in (nir, green, red):
        path.write_bytes(b"")
    ordered, known = _order_band_files([nir, green, red])
    assert ordered == [green, red, nir]
    assert known is True


def test_order_band_files_numeric_fallback(tmp_path):
    paths = [tmp_path / name for name in ("b3.tif", "b1.tif", "b2.tif")]
    for path in paths:
        path.write_bytes(b"")
    ordered, known = _order_band_files(paths)
    assert [path.name for path in ordered] == ["b1.tif", "b2.tif", "b3.tif"]
    assert known is False


def test_order_band_files_single_file_still_works(tmp_path):
    only = tmp_path / "merged.tif"
    only.write_bytes(b"")
    ordered, known = _order_band_files([only])
    assert ordered == [only]
    assert known is False


def test_locate_sources_from_zip(tmp_path):
    delivery = tmp_path / "delivery.zip"
    with zipfile.ZipFile(delivery, "w") as archive:
        archive.writestr("product/green.tif", b"1")
        archive.writestr("product/red.tif", b"2")
        archive.writestr("product/nir.tif", b"3")
    found = _locate_sources(delivery, tmp_path / "src")
    assert sorted(p.name for p in found) == ["green.tif", "nir.tif", "red.tif"]


def test_locate_sources_single_tif(tmp_path):
    tif = tmp_path / "scene.tif"
    tif.write_bytes(b"")
    assert _locate_sources(tif, tmp_path / "src") == [tif]


def test_locate_sources_rejects_unknown_type(tmp_path):
    other = tmp_path / "notes.txt"
    other.write_text("hi", encoding="utf-8")
    with pytest.raises(IngestError, match="unsupported delivery"):
        _locate_sources(other, tmp_path / "src")


def test_locate_sources_requires_geotiff(tmp_path):
    delivery = tmp_path / "delivery.zip"
    with zipfile.ZipFile(delivery, "w") as archive:
        archive.writestr("readme.txt", b"no imagery here")
    with pytest.raises(IngestError, match="no GeoTIFF"):
        _locate_sources(delivery, tmp_path / "src")


def test_extract_zip_blocks_zip_slip(tmp_path):
    delivery = tmp_path / "evil.zip"
    with zipfile.ZipFile(delivery, "w") as archive:
        archive.writestr("../escaped.txt", b"pwned")
    with pytest.raises(IngestError, match="unsafe zip member"):
        _extract_zip(delivery, tmp_path / "src")
    assert not (tmp_path / "escaped.txt").exists()


def test_extract_zip_happy_path(tmp_path):
    delivery = tmp_path / "ok.zip"
    with zipfile.ZipFile(delivery, "w") as archive:
        archive.writestr("nested/scene.tif", b"tif")
    dest = tmp_path / "src"
    _extract_zip(delivery, dest)
    assert (dest / "nested" / "scene.tif").read_bytes() == b"tif"


def test_list_tiles_filters_to_xyz_pngs(tmp_path):
    (tmp_path / "11" / "1234" / "5678").mkdir(parents=True)
    (tmp_path / "11" / "1234" / "5678.png").write_bytes(b"a")
    (tmp_path / "12" / "1").mkdir(parents=True)
    (tmp_path / "12" / "1" / "2.png").write_bytes(b"b")
    (tmp_path / "readme.png").write_bytes(b"c")
    (tmp_path / "11" / "1").mkdir(parents=True)
    (tmp_path / "11" / "1" / "2.jpg").write_bytes(b"d")
    tiles = _list_tiles(tmp_path)
    assert sorted(p.name for p in tiles) == ["2.png", "5678.png"]
