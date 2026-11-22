"""
Bhoonidhi API client (NRSC, https://bhoonidhi-api.nrsc.gov.in).

Specification-driven behaviour:
- ONE token per run: password grant on first use, refresh_token grant when
  close to expiry — the token endpoint allows only 20 requests/hour/IP.
- Logout (POST /auth/logout, `Authorization: Bearer <refresh_token>`) always
  runs on close, even when the run fails; otherwise sessions pile up and the
  next run hits 403 "maximum sessions already active".
- Search is throttled to 3 requests/second; downloads run strictly one at a
  time (limit: 3 concurrent per user+IP; we use 1).
- Transient failures (429/500/502/503/504 and download 412) WAIT through a
  long exponential backoff — never an immediate retry.
- Secrets come from the environment only (BHOONIDHI_USER, BHOONIDHI_PASSWORD)
  and never appear in logs, messages or exceptions.
"""

from __future__ import annotations

import os
import random
import time
from typing import Any, Callable, Mapping

import requests

BASE_URL = "https://bhoonidhi-api.nrsc.gov.in"

# Search: at most 3 requests/second per IP.
SEARCH_INTERVAL_S = 1.0 / 3.0
# Refresh the access token this many seconds before it expires.
TOKEN_REFRESH_MARGIN_S = 60.0
# Long exponential backoff (WAIT logic, per the spec): 30s → 10min + jitter.
BACKOFF_DELAYS_S = (30.0, 60.0, 120.0, 300.0, 600.0)


class BhoonidhiError(RuntimeError):
    """API failure. Messages never carry tokens, passwords or raw headers."""

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


def _safe_json(response: requests.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def error_message(body: Any, status: int) -> str:
    """Format the documented {"ErrorCode", "Description", "Action"} body
    defensively — other shapes fall back to the status code only."""
    if isinstance(body, dict):
        code = body.get("ErrorCode") or body.get("error") or body.get("code")
        desc = (
            body.get("Description")
            or body.get("error_description")
            or body.get("message")
        )
        action = body.get("Action")
        parts = [str(p) for p in (code, desc) if p]
        if action:
            parts.append(f"action: {action}")
        if parts:
            return f"HTTP {status}: " + " — ".join(parts)
    return f"HTTP {status}"


def client_from_env(**kwargs: Any) -> "BhoonidhiClient":
    """Build a client from BHOONIDHI_USER / BHOONIDHI_PASSWORD only — the
    credentials are never accepted as arguments or printed."""
    user = os.environ.get("BHOONIDHI_USER", "")
    password = os.environ.get("BHOONIDHI_PASSWORD", "")
    if not user or not password:
        raise BhoonidhiError(
            "BHOONIDHI_USER and BHOONIDHI_PASSWORD must be set in the "
            "environment (secrets only — never passed on the command line)"
        )
    return BhoonidhiClient(user, password, **kwargs)


class BhoonidhiClient:
    """Session-scoped client: `with client_from_env() as client:` guarantees
    the logout call in a finally block."""

    def __init__(
        self,
        user: str,
        password: str,
        *,
        base_url: str = BASE_URL,
        session: requests.Session | None = None,
        sleep: Callable[[float], None] | None = None,
        now: Callable[[], float] | None = None,
        jitter: Callable[[float], float] | None = None,
    ) -> None:
        self._user = user
        self._password = password
        self._base = base_url.rstrip("/")
        self._http = session if session is not None else requests.Session()
        self._sleep = sleep if sleep is not None else time.sleep
        self._now = now if now is not None else time.monotonic
        # jitter(scale) -> seconds to wait on top of the nominal delay
        self._jitter = jitter if jitter is not None else (lambda s: random.uniform(0, s))
        self._access: str | None = None
        self._refresh: str | None = None
        self._expires_at = 0.0
        self._last_search_at: float | None = None

    # ------------------------------------------------------------------ #
    # lifecycle — logout always runs, success or failure                  #
    # ------------------------------------------------------------------ #

    def __enter__(self) -> "BhoonidhiClient":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        self.close()
        return False

    def close(self) -> None:
        """POST /auth/logout with the refresh token (best-effort)."""
        refresh = self._refresh
        self._access = None
        self._refresh = None
        if not refresh:
            return
        try:
            self._http.post(
                f"{self._base}/auth/logout",
                headers={"Authorization": f"Bearer {refresh}"},
                timeout=30,
            )
        except requests.RequestException:
            pass  # the access token expires on its own; never mask the run's error

    # ------------------------------------------------------------------ #
    # token handling — one fetch per run, refresh just before expiry      #
    # ------------------------------------------------------------------ #

    def _store_token(self, data: Any) -> None:
        if not isinstance(data, dict):
            raise BhoonidhiError("token response is not a JSON object")
        access = data.get("access_token")
        if not isinstance(access, str) or not access:
            raise BhoonidhiError("token response missing access_token")
        self._access = access
        refresh = data.get("refresh_token")
        if isinstance(refresh, str) and refresh:
            self._refresh = refresh
        try:
            expires_in = float(data.get("expires_in") or 1200)
        except (TypeError, ValueError):
            expires_in = 1200.0
        self._expires_at = self._now() + expires_in

    def _fetch_token(self, payload: Mapping[str, Any]) -> Any:
        """POST /auth/token with WAIT-retries on transient errors. 401/403/429
        raise immediately — they need operator action, not a retry loop."""
        last: Exception | None = None
        for delay in (0.0,) + BACKOFF_DELAYS_S:
            if delay:
                self._sleep(delay + self._jitter(delay * 0.2))
            try:
                response = self._http.post(
                    f"{self._base}/auth/token",
                    json=dict(payload),
                    timeout=30,
                )
            except requests.RequestException as exc:
                last = BhoonidhiError(f"token request failed ({exc.__class__.__name__})")
                continue
            status = response.status_code
            body = _safe_json(response)
            if status == 200:
                return body
            if status == 401:
                raise BhoonidhiError(
                    error_message(body, 401) + " — wrong userId/password",
                    status=401,
                )
            if status == 403:
                raise BhoonidhiError(
                    error_message(body, 403)
                    + " — maximum sessions already active; log out other "
                    "Bhoonidhi sessions and retry",
                    status=403,
                )
            if status == 429:
                raise BhoonidhiError(
                    error_message(body, 429)
                    + " — token rate limit is 20/hour; wait ~3 hours "
                    "(one token per run keeps us well inside it)",
                    status=429,
                )
            if status >= 500:
                last = BhoonidhiError(error_message(body, status), status=status)
                continue
            raise BhoonidhiError(error_message(body, status), status=status)
        raise last if last else BhoonidhiError("token request failed after retries")

    def _ensure_token(self) -> None:
        if self._access and self._now() < self._expires_at - TOKEN_REFRESH_MARGIN_S:
            return
        if self._refresh:
            try:
                self._store_token(
                    self._fetch_token(
                        {
                            "userId": self._user,
                            "refresh_token": self._refresh,
                            "grant_type": "refresh_token",
                        }
                    )
                )
                return
            except BhoonidhiError as exc:
                if exc.status not in (401,):
                    raise
                # refresh token dead → fall back to the password grant
        self._store_token(
            self._fetch_token(
                {
                    "userId": self._user,
                    "password": self._password,
                    "grant_type": "password",
                }
            )
        )

    # ------------------------------------------------------------------ #
    # HTTP with backoff                                                   #
    # ------------------------------------------------------------------ #

    def _url(self, path: str) -> str:
        if path.startswith("http://") or path.startswith("https://"):
            return path
        if not path.startswith("/"):
            path = "/" + path
        return f"{self._base}{path}"

    def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: Any = None,
        auth: bool = True,
    ) -> Any:
        url = self._url(path)
        last: Exception | None = None
        auth_refreshed = False
        for delay in (0.0,) + BACKOFF_DELAYS_S:
            if delay:
                self._sleep(delay + self._jitter(delay * 0.2))
            if auth:
                self._ensure_token()
            headers = {"Authorization": f"Bearer {self._access}"} if auth else {}
            try:
                response = self._http.request(
                    method,
                    url,
                    json=json_body,
                    headers=headers,
                    timeout=60,
                )
            except requests.RequestException as exc:
                last = BhoonidhiError(f"{method} {url} failed ({exc.__class__.__name__})")
                continue
            status = response.status_code
            body = _safe_json(response)
            if status == 200:
                return body
            if status == 401 and auth and not auth_refreshed:
                auth_refreshed = True
                self._access = None  # force a refresh on the next loop pass
                last = BhoonidhiError(error_message(body, 401) + " (session expired)", status=401)
                continue
            if status in (429, 500, 502, 503, 504):
                last = BhoonidhiError(error_message(body, status), status=status)
                continue
            raise BhoonidhiError(error_message(body, status), status=status)
        raise last if last else BhoonidhiError(f"{method} {url} failed after retries")

    # ------------------------------------------------------------------ #
    # search (STAC)                                                       #
    # ------------------------------------------------------------------ #

    def _throttle_search(self) -> None:
        now = self._now()
        if self._last_search_at is not None:
            wait = self._last_search_at + SEARCH_INTERVAL_S - now
            if wait > 0:
                self._sleep(wait)
        self._last_search_at = self._now()

    def search(
        self,
        *,
        collections: list[str],
        datetime_range: str,
        intersects: Mapping[str, Any],
        limit: int = 500,
        online_only: bool = True,
        max_pages: int = 100,
    ) -> list[dict]:
        """POST /data/search, following rel="next" links (same body each
        page). Only Online=Y items are directly downloadable."""
        body: dict[str, Any] = {
            "collections": list(collections),
            "datetime": datetime_range,
            "intersects": dict(intersects),
            "limit": limit,
        }
        if online_only:
            body["filter"] = {"args": [{"property": "Online"}, "Y"], "op": "eq"}
            body["filter-lang"] = "cql2-json"
        features: list[dict] = []
        url: str | None = "/data/search"
        seen: set[str] = set()
        pages = 0
        while url:
            absolute = self._url(url)
            if absolute in seen:
                break
            seen.add(absolute)
            pages += 1
            if pages > max_pages:
                raise BhoonidhiError(f"search pagination exceeded {max_pages} pages")
            self._throttle_search()
            data = self._request("POST", absolute, json_body=body)
            if isinstance(data, dict):
                found = data.get("features")
                if isinstance(found, list):
                    features.extend(f for f in found if isinstance(f, dict))
            url = next_link(data)
        return features

    def get_item(self, collection: str, item_id: str) -> dict:
        data = self._request("GET", f"/data/collections/{collection}/items/{item_id}")
        if not isinstance(data, dict) or not data.get("id"):
            raise BhoonidhiError(f"item {item_id!r} not found in {collection}", status=404)
        return data

    # ------------------------------------------------------------------ #
    # download — sequential, WAIT-retries                                 #
    # ------------------------------------------------------------------ #

    def download(self, item_id: str, collection: str, dest: str) -> str:
        """GET /download?id=&collection= streamed to `dest`. Retries WAIT on
        412/429/5xx/504 (interrupted) and restart the transfer from scratch."""
        params = {"id": item_id, "collection": collection}
        last: Exception | None = None
        auth_refreshed = False
        for delay in (0.0,) + BACKOFF_DELAYS_S:
            if delay:
                self._sleep(delay + self._jitter(delay * 0.2))
            self._ensure_token()
            try:
                response = self._http.get(
                    self._url("/download"),
                    params=params,
                    headers={"Authorization": f"Bearer {self._access}"},
                    timeout=(30, 300),
                    stream=True,
                )
            except requests.RequestException as exc:
                last = BhoonidhiError(f"download failed ({exc.__class__.__name__})")
                continue
            status = response.status_code
            if status == 200:
                try:
                    with open(dest, "wb") as handle:
                        for chunk in response.iter_content(chunk_size=1 << 20):
                            if chunk:
                                handle.write(chunk)
                    return dest
                except (requests.RequestException, OSError) as exc:
                    last = BhoonidhiError(
                        f"download interrupted ({exc.__class__.__name__}) — will retry"
                    )
                    _remove_quietly(dest)
                    continue
                finally:
                    response.close()
            body = _safe_json(response)
            response.close()
            if status == 401 and not auth_refreshed:
                auth_refreshed = True
                self._access = None
                last = BhoonidhiError(error_message(body, 401) + " (session expired)", status=401)
                continue
            if status == 404:
                raise BhoonidhiError(
                    error_message(body, 404)
                    + " — item is not on online storage; order it through the "
                    "portal's Browse & Order",
                    status=404,
                )
            if status in (412, 429, 500, 502, 503, 504):
                last = BhoonidhiError(error_message(body, status), status=status)
                continue
            raise BhoonidhiError(error_message(body, status), status=status)
        raise last if last else BhoonidhiError("download failed after retries")


def next_link(payload: Any) -> str | None:
    """rel="next" href from a STAC FeatureCollection (defensive)."""
    if not isinstance(payload, dict):
        return None
    links = payload.get("links")
    if not isinstance(links, list):
        return None
    for link in links:
        if isinstance(link, dict) and link.get("rel") == "next":
            href = link.get("href")
            if isinstance(href, str) and href:
                return href
    return None


def _remove_quietly(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
