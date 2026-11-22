"""Supabase Storage/REST writer tests — mocked HTTP only."""

from __future__ import annotations

import pytest

from conftest import FakeHttp, FakeResponse
from storage import (
    BACKOFF_DELAYS_S,
    BUCKET,
    SupabaseTiles,
    StorageError,
    config_from_env,
)

URL = "https://example.supabase.co"
KEY = "service-role-secret-key-value"


def make_tiles(http: FakeHttp) -> tuple[SupabaseTiles, list[float]]:
    sleeps: list[float] = []
    tiles = SupabaseTiles(
        URL, KEY, session=http, sleep=sleeps.append, log=lambda _message: None
    )
    return tiles, sleeps


def test_config_from_env_requires_both(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    with pytest.raises(StorageError) as excinfo:
        config_from_env()
    message = str(excinfo.value)
    assert "SUPABASE_URL" in message
    assert "SUPABASE_SERVICE_ROLE_KEY" in message


def test_config_from_env_strips_trailing_slash(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co/")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", KEY)
    url, key = config_from_env()
    assert url == "https://example.supabase.co"
    assert key == KEY


def test_config_from_env_rejects_non_http(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "ftp://nope")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", KEY)
    with pytest.raises(StorageError, match="http"):
        config_from_env()


# --------------------------------------------------------------------------- #
# uploads                                                                     #
# --------------------------------------------------------------------------- #


def test_upload_bytes_sets_auth_and_upsert_headers(fake_http):
    fake_http.add(FakeResponse(200, {"Key": "x"}))
    tiles, _sleeps = make_tiles(fake_http)
    sent = tiles.upload_bytes("scene/1/2/3.png", b"png-bytes",
                              content_type="image/png")
    assert sent == len(b"png-bytes")
    method, url, kwargs = fake_http.calls[0]
    assert method == "POST"
    assert url == f"{URL}/storage/v1/object/{BUCKET}/scene/1/2/3.png"
    headers = kwargs["headers"]
    assert headers["Authorization"] == f"Bearer {KEY}"
    assert headers["apikey"] == KEY
    assert headers["Content-Type"] == "image/png"
    assert headers["x-upsert"] == "true"
    assert kwargs["data"] == b"png-bytes"


def test_upload_retries_transient_statuses(fake_http):
    fake_http.add(FakeResponse(503, {"message": "busy"}))
    fake_http.add(FakeResponse(200, {}))
    tiles, sleeps = make_tiles(fake_http)
    assert tiles.upload_png("s/a.png", b"x") == 1
    assert len(fake_http.calls) == 2
    assert sleeps == [BACKOFF_DELAYS_S[0]]


def test_upload_raises_on_permanent_error_without_key_leak(fake_http):
    fake_http.add(FakeResponse(403, {"message": "forbidden"}))
    tiles, sleeps = make_tiles(fake_http)
    with pytest.raises(StorageError) as excinfo:
        tiles.upload_png("s/a.png", b"x")
    assert "403" in str(excinfo.value)
    assert KEY not in str(excinfo.value)
    assert sleeps == []  # no backoff for permanent failures


def test_upload_gives_up_after_backoff(fake_http):
    attempts = 1 + len(BACKOFF_DELAYS_S)
    for _ in range(attempts):
        fake_http.add(FakeResponse(500, {"message": "down"}))
    tiles, sleeps = make_tiles(fake_http)
    with pytest.raises(StorageError):
        tiles.upload_png("s/a.png", b"x")
    assert len(fake_http.calls) == attempts
    assert len(sleeps) == len(BACKOFF_DELAYS_S)


# --------------------------------------------------------------------------- #
# tile directory walk                                                         #
# --------------------------------------------------------------------------- #


def test_upload_tiles_walks_xyz_layout_only(fake_http, tmp_path):
    tiles_dir = tmp_path / "tiles"
    (tiles_dir / "11" / "1234" / "5678").mkdir(parents=True)
    (tiles_dir / "11" / "1234" / "5678.png").write_bytes(b"aaaa")
    (tiles_dir / "12" / "9").mkdir(parents=True)
    (tiles_dir / "12" / "9" / "10.png").write_bytes(b"bb")
    (tiles_dir / "readme.png").write_bytes(b"ignored")  # not z/x/y
    (tiles_dir / "11" / "x").mkdir(parents=True)
    (tiles_dir / "11" / "x" / "y.png").write_bytes(b"ignored")  # not numeric
    for _ in range(3):
        fake_http.add(FakeResponse(200, {}))
    client, _sleeps = make_tiles(fake_http)
    count, total = client.upload_tiles("scene-1", str(tiles_dir))
    assert count == 2
    assert total == len(b"aaaa") + len(b"bb")
    paths = [call[1] for call in fake_http.calls]
    assert f"{URL}/storage/v1/object/{BUCKET}/scene-1/11/1234/5678.png" in paths
    assert f"{URL}/storage/v1/object/{BUCKET}/scene-1/12/9/10.png" in paths
    assert all("readme" not in path for path in paths)


def test_upload_tiles_missing_directory(fake_http, tmp_path):
    client, _sleeps = make_tiles(fake_http)
    with pytest.raises(StorageError, match="tiles directory not found"):
        client.upload_tiles("s", str(tmp_path / "nope"))


# --------------------------------------------------------------------------- #
# vhr_scenes row                                                              #
# --------------------------------------------------------------------------- #


def test_insert_scene_returns_represented_row(fake_http):
    row = {"id": "scene-1", "tile_count": 3}
    fake_http.add(FakeResponse(201, [dict(row)]))
    client, _sleeps = make_tiles(fake_http)
    inserted = client.insert_scene(row)
    assert inserted["id"] == "scene-1"
    method, url, kwargs = fake_http.calls[0]
    assert method == "POST"
    assert url == f"{URL}/rest/v1/vhr_scenes"
    assert kwargs["headers"]["Prefer"] == "return=representation"
    assert kwargs["headers"]["apikey"] == KEY


def test_insert_scene_retries_then_fails(fake_http):
    attempts = 1 + len(BACKOFF_DELAYS_S)
    for _ in range(attempts):
        fake_http.add(FakeResponse(500, {"message": "down"}))
    client, sleeps = make_tiles(fake_http)
    with pytest.raises(StorageError):
        client.insert_scene({"id": "x"})
    assert len(sleeps) == len(BACKOFF_DELAYS_S)


def test_insert_scene_permanent_error(fake_http):
    fake_http.add(FakeResponse(400, {"message": "null value in column"}))
    client, sleeps = make_tiles(fake_http)
    with pytest.raises(StorageError) as excinfo:
        client.insert_scene({"id": "x"})
    assert "400" in str(excinfo.value)
    assert KEY not in str(excinfo.value)
    assert sleeps == []
