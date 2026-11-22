"""Pure-helper tests for the VHR pipeline — no GDAL, no network."""

from __future__ import annotations

import json
import math

import pytest

from pipeline import (
    MAX_AOI_KM2,
    TILE_LIMIT,
    PipelineError,
    aoi_area_km2,
    bbox_of,
    center_lat,
    check_aoi_size,
    check_tile_count,
    coverage_percent,
    format_candidates_markdown,
    geometry_of,
    load_aoi,
    map_bands,
    max_zoom_for,
    min_zoom_for,
    online_flag,
    parse_bands_override,
    property_keys,
    scene_candidate,
)


def square(min_lng=0.0, min_lat=0.0, max_lng=0.1, max_lat=0.1) -> dict:
    return {
        "type": "Polygon",
        "coordinates": [
            [
                [min_lng, min_lat],
                [max_lng, min_lat],
                [max_lng, max_lat],
                [min_lng, max_lat],
                [min_lng, min_lat],
            ]
        ],
    }


# --------------------------------------------------------------------------- #
# AOI loading                                                                 #
# --------------------------------------------------------------------------- #


def test_load_aoi_from_inline_json():
    geometry = load_aoi(json.dumps(square()))
    assert geometry["type"] == "Polygon"


def test_load_aoi_from_file(tmp_path):
    path = tmp_path / "aoi.geojson"
    path.write_text(json.dumps(square()), encoding="utf-8")
    assert load_aoi(str(path))["type"] == "Polygon"


def test_load_aoi_accepts_feature_and_feature_collection():
    feature = {"type": "Feature", "geometry": square(), "properties": {}}
    assert geometry_of(feature)["type"] == "Polygon"
    collection = {"type": "FeatureCollection", "features": [feature]}
    assert geometry_of(collection)["type"] == "Polygon"


def test_load_aoi_rejects_non_polygonal():
    with pytest.raises(PipelineError, match="Polygon"):
        geometry_of({"type": "Point", "coordinates": [0, 0]})
    with pytest.raises(PipelineError, match="Polygon"):
        geometry_of({"type": "Feature", "geometry": {"type": "Point"},
                     "coordinates": [0, 0]})
    with pytest.raises(PipelineError):
        geometry_of({"type": "FeatureCollection", "features": []})
    with pytest.raises(PipelineError):
        load_aoi("not json at all")
    with pytest.raises(PipelineError, match="neither an existing file"):
        load_aoi("/definitely/missing/aoi.geojson")


def test_load_aoi_missing_file_path_like_string_raises():
    # a bare path that does not exist and is not JSON
    with pytest.raises(PipelineError):
        load_aoi("C:/no/such/file/here.geojson")


# --------------------------------------------------------------------------- #
# area guard                                                                  #
# --------------------------------------------------------------------------- #


def test_aoi_area_matches_spherical_reference():
    # 0.1 x 0.1 degrees at the equator ~ 123.6 km2
    area = aoi_area_km2(square())
    assert area == pytest.approx(123.6, rel=0.01)


def test_check_aoi_size_accepts_small_and_rejects_large():
    assert check_aoi_size(square()) == pytest.approx(123.6, rel=0.01)
    big = square(70.0, 20.0, 76.0, 26.0)  # 6 x 6 degrees
    with pytest.raises(PipelineError, match="km²"):
        check_aoi_size(big)
    assert aoi_area_km2(big) > MAX_AOI_KM2


def test_check_aoi_size_rejects_zero_area():
    degenerate = {
        "type": "Polygon",
        "coordinates": [[[0, 0], [0, 0], [0, 0], [0, 0]]],
    }
    with pytest.raises(PipelineError, match="zero area"):
        check_aoi_size(degenerate)


# --------------------------------------------------------------------------- #
# bbox / coverage                                                             #
# --------------------------------------------------------------------------- #


def test_bbox_and_center():
    box = bbox_of(square(74.0, 26.0, 75.0, 27.0))
    assert box == (74.0, 26.0, 75.0, 27.0)
    assert center_lat(square(74.0, 26.0, 75.0, 27.0)) == pytest.approx(26.5)
    assert bbox_of(None) is None


def test_coverage_full_and_none():
    aoi = square(74.0, 26.0, 74.5, 26.5)
    covering = square(73.0, 25.0, 76.0, 28.0)
    disjoint = square(80.0, 30.0, 81.0, 31.0)
    assert coverage_percent(covering, aoi) == pytest.approx(100.0, abs=1.0)
    assert coverage_percent(disjoint, aoi) == 0.0
    assert coverage_percent(None, aoi) == 0.0


def test_coverage_half_overlap():
    aoi = square(0.0, 0.0, 1.0, 1.0)
    half = square(0.5, 0.0, 2.0, 1.0)
    assert coverage_percent(half, aoi) == pytest.approx(50.0, abs=3.0)


# --------------------------------------------------------------------------- #
# band mapping                                                                #
# --------------------------------------------------------------------------- #


def test_three_band_defaults_to_false_colour():
    mapping = map_bands(3, None)
    assert mapping.kind == "rgb"
    assert mapping.bands == (3, 2, 1)  # NIR, red, green


def test_single_band_defaults_to_grayscale():
    mapping = map_bands(1, None)
    assert mapping.kind == "gray"
    assert mapping.bands == (1,)


@pytest.mark.parametrize("count", [2, 4, 5])
def test_ambiguous_band_counts_require_override(count):
    with pytest.raises(PipelineError, match="--bands"):
        map_bands(count, None)


def test_explicit_override_is_used():
    mapping = map_bands(4, "4,3,2")
    assert mapping.kind == "rgb"
    assert mapping.bands == (4, 3, 2)


def test_override_cannot_reference_missing_band():
    with pytest.raises(PipelineError, match="band 5"):
        map_bands(4, "5,4,3")


@pytest.mark.parametrize("value", ["1,2", "a,b,c", "0,1,2", "1,2,3,4"])
def test_malformed_override_rejected(value):
    with pytest.raises(PipelineError):
        parse_bands_override(value)
    with pytest.raises(PipelineError):
        map_bands(3, value)


def test_empty_override_is_none():
    assert parse_bands_override(None) is None
    assert parse_bands_override("  ") is None


# --------------------------------------------------------------------------- #
# zoom & tile limits                                                          #
# --------------------------------------------------------------------------- #


def test_max_zoom_matches_ground_resolution_formula():
    expected = int(round(math.log2(156543.03 * math.cos(math.radians(26.0)) / 5.8)))
    assert max_zoom_for(5.8, 26.0) == expected
    assert max_zoom_for(5.8, 0.0) == 15
    # zoom shrinks as resolution coarsens
    assert max_zoom_for(10.0, 0.0) < max_zoom_for(5.8, 0.0)


def test_max_zoom_rejects_bad_resolution():
    with pytest.raises(PipelineError):
        max_zoom_for(0.0, 26.0)


def test_min_zoom_floor():
    assert min_zoom_for(15) == 11
    assert min_zoom_for(14) == 11  # never below 11
    assert min_zoom_for(17) == 13


def test_tile_count_limit():
    assert check_tile_count(TILE_LIMIT) == TILE_LIMIT
    with pytest.raises(PipelineError, match="tile limit"):
        check_tile_count(TILE_LIMIT + 1)


# --------------------------------------------------------------------------- #
# candidate rows                                                              #
# --------------------------------------------------------------------------- #


def test_scene_candidate_reads_datetime_and_online():
    feature = {
        "id": "RS2_LISS4_001",
        "collection": "ResourceSat-2_LISS4-MX70_L2",
        "geometry": square(73.0, 25.0, 76.0, 28.0),
        "properties": {
            "datetime": "2024-05-01T05:30:00Z",
            "Online": "Y",
        },
    }
    row = scene_candidate(feature, square(74.0, 26.0, 74.5, 26.5))
    assert row["item_id"] == "RS2_LISS4_001"
    assert row["collection"] == "ResourceSat-2_LISS4-MX70_L2"
    assert row["date"] == "2024-05-01"
    assert row["online"] == "Y"
    assert row["coverage"] == pytest.approx(100.0, abs=1.0)


def test_scene_candidate_tolerates_missing_properties():
    row = scene_candidate({"id": "x"}, square())
    assert row["item_id"] == "x"
    assert row["collection"] == ""
    assert row["date"] == ""
    assert row["online"] == "?"
    assert row["coverage"] == 0.0


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Y", "Y"),
        ("N", "N"),
        (True, "Y"),
        (False, "N"),
        ("yes", "Y"),
        (None, "?"),
        ("weird", "WEIRD"),
    ],
)
def test_online_flag(value, expected):
    props = {} if value is None else {"Online": value}
    assert online_flag(props) == expected


def test_property_keys_sorted():
    assert property_keys({"properties": {"b": 1, "a": 2}}) == ["a", "b"]
    assert property_keys({}) == []
    assert property_keys({"properties": None}) == []


def test_format_candidates_markdown():
    rows = [
        {"item_id": "a", "collection": "C1", "date": "2024-01-01",
         "coverage": 97.5, "online": "Y"},
        {"item_id": "b", "collection": "C1", "date": "",
         "coverage": 0.0, "online": "N"},
    ]
    text = format_candidates_markdown(rows, aoi_area=12.5)
    assert "| Item id |" in text
    assert "| a | C1 | 2024-01-01 | 97.5% | Y |" in text
    assert "12.50 km²" in text
    assert "matched 2 scene(s)" in text


def test_format_candidates_markdown_empty():
    text = format_candidates_markdown([], aoi_area=1.0)
    assert "no scenes matched" in text
