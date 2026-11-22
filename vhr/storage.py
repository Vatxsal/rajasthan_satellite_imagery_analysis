"""
Supabase Storage / REST writer for ingested VHR tiles.

Runs on the ingest host (Docker or CI runner) with the service-role key
(SUPABASE_SERVICE_ROLE_KEY) — the key is read from the environment only and
never printed. The browser never talks to Supabase for VHR tiles; the Next.js
app proxies every request server-side.
"""

from __future__ import annotations

import json
import os
from typing import Any, Callable, Mapping

import requests

BUCKET = "vhr-tiles"
TABLE = "vhr_scenes"
# Storage upload retryable statuses (transient infra failures).
RETRYABLE = (429, 500, 502, 503, 504)
BACKOFF_DELAYS_S = (2.0, 5.0, 15.0)


class StorageError(RuntimeError):
    """Upload/DB failure. Messages never carry the service-role key."""


def _safe_json(response: requests.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def config_from_env() -> tuple[str, str]:
    """(supabase_url, service_role_key) — env only, never CLI args."""
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise StorageError(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the "
            "environment (secrets only — never passed on the command line)"
        )
    if not url.startswith("http"):
        raise StorageError("SUPABASE_URL must be an http(s) URL")
    return url, key


class SupabaseTiles:
    """Thin Storage + REST client. `session`, `sleep` and `log` are
    injectable so the tests run without a network."""

    def __init__(
        self,
        url: str,
        key: str,
        *,
        session: requests.Session | None = None,
        sleep: Callable[[float], None] | None = None,
        log: Callable[[str], None] | None = None,
    ) -> None:
        self._base = url.rstrip("/")
        self._key = key
        self._http = session if session is not None else requests.Session()
        self._sleep = sleep if sleep is not None else (lambda seconds: None)
        self._log = log if log is not None else (lambda message: None)

    @classmethod
    def from_env(cls, **kwargs: Any) -> "SupabaseTiles":
        url, key = config_from_env()
        return cls(url, key, **kwargs)

    # ------------------------------------------------------------------ #
    # Storage (private bucket)                                            #
    # ------------------------------------------------------------------ #

    def upload_png(self, scene_path: str, data: bytes) -> int:
        return self.upload_bytes(scene_path, data, content_type="image/png")

    def upload_bytes(
        self, scene_path: str, data: bytes, *, content_type: str
    ) -> int:
        """POST /storage/v1/object/<bucket>/<path> with x-upsert: true."""
        path = f"{self._base}/storage/v1/object/{BUCKET}/{scene_path}"
        last: Exception | None = None
        for _attempt, delay in enumerate((0.0,) + BACKOFF_DELAYS_S):
            if delay:
                self._sleep(delay)
            try:
                response = self._http.post(
                    path,
                    data=data,
                    headers={
                        "Authorization": f"Bearer {self._key}",
                        "apikey": self._key,
                        "Content-Type": content_type,
                        "x-upsert": "true",
                    },
                    timeout=60,
                )
            except requests.RequestException as exc:
                last = StorageError(f"upload failed ({exc.__class__.__name__})")
                continue
            if response.status_code in (200, 201):
                return len(data)
            if response.status_code in RETRYABLE:
                last = StorageError(
                    f"upload {scene_path}: HTTP {response.status_code}"
                )
                continue
            raise StorageError(
                f"upload {scene_path}: HTTP {response.status_code} — "
                f"{_safe_json(response)}"
            )
        raise last if last else StorageError(f"upload {scene_path} failed")

    def upload_tiles(self, scene_id: str, tiles_dir: str) -> tuple[int, int]:
        """Walk `<tiles_dir>/<z>/<x>/<y>.png` and upload every tile.
        Returns (tile_count, total_bytes)."""
        import pathlib
        import re

        root = pathlib.Path(tiles_dir)
        if not root.is_dir():
            raise StorageError(f"tiles directory not found: {tiles_dir}")
        pattern = re.compile(r"^\d+/\d+/\d+\.png$")
        count = 0
        total = 0
        files = sorted(
            path
            for path in root.rglob("*.png")
            if pattern.match(path.relative_to(root).as_posix())
        )
        for file in files:
            relative = file.relative_to(root).as_posix()
            scene_path = f"{scene_id}/{relative}"
            total += self.upload_bytes(
                scene_path, file.read_bytes(), content_type="image/png"
            )
            count += 1
            if count % 100 == 0:
                self._log(f"  uploaded {count} tiles...")
        return count, total

    # ------------------------------------------------------------------ #
    # vhr_scenes row                                                      #
    # ------------------------------------------------------------------ #

    def insert_scene(self, row: Mapping[str, Any]) -> dict:
        """POST /rest/v1/vhr_scenes, returns the inserted row (representation)."""
        path = f"{self._base}/rest/v1/{TABLE}"
        last: Exception | None = None
        payload = json.dumps(dict(row)).encode("utf-8")
        for delay in (0.0,) + BACKOFF_DELAYS_S:
            if delay:
                self._sleep(delay)
            try:
                response = self._http.post(
                    path,
                    data=payload,
                    headers={
                        "Authorization": f"Bearer {self._key}",
                        "apikey": self._key,
                        "Content-Type": "application/json",
                        "Prefer": "return=representation",
                    },
                    timeout=60,
                )
            except requests.RequestException as exc:
                last = StorageError(f"insert_scene failed ({exc.__class__.__name__})")
                continue
            if response.status_code in (200, 201):
                body = _safe_json(response)
                if isinstance(body, list) and body and isinstance(body[0], dict):
                    return body[0]
                return dict(row)
            if response.status_code in RETRYABLE:
                last = StorageError(f"insert_scene: HTTP {response.status_code}")
                continue
            raise StorageError(
                f"insert_scene: HTTP {response.status_code} — {_safe_json(response)}"
            )
        raise last if last else StorageError("insert_scene failed")
