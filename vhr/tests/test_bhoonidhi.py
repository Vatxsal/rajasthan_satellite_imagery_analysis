"""Unit tests for the Bhoonidhi API client — mocked HTTP only, no network."""

from __future__ import annotations

import pytest

from bhoonidhi import (
    BACKOFF_DELAYS_S,
    BhoonidhiClient,
    BhoonidhiError,
    client_from_env,
    error_message,
    next_link,
)
from conftest import FakeClock, FakeHttp, FakeResponse

COLLECTIONS = ["ResourceSat-2_LISS4-MX70_L2"]
RANGE = "2024-01-01T00:00:00Z/2024-01-31T23:59:59Z"
INTERSECTS = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}


def token(access: str = "acc-1", refresh: str = "ref-1", expires: float = 1200):
    return FakeResponse(
        200,
        {"access_token": access, "refresh_token": refresh, "expires_in": expires},
    )


def page(features: list[dict], next_href: str | None = None):
    links = [{"rel": "next", "href": next_href}] if next_href else []
    return FakeResponse(200, {"features": features, "links": links})


def make_client(http: FakeHttp, clock: FakeClock) -> BhoonidhiClient:
    return BhoonidhiClient(
        "user-1",
        "sekret-pw",
        session=http,
        sleep=clock.sleep,
        now=clock.now,
        jitter=lambda _scale: 0.0,
    )


def search(client: BhoonidhiClient, **kwargs):
    return client.search(
        collections=kwargs.get("collections", COLLECTIONS),
        datetime_range=kwargs.get("datetime_range", RANGE),
        intersects=kwargs.get("intersects", INTERSECTS),
    )


def calls_to(http: FakeHttp, suffix: str) -> list[tuple[str, str, dict]]:
    return [call for call in http.calls if suffix in call[1]]


# --------------------------------------------------------------------------- #
# credentials                                                                  #
# --------------------------------------------------------------------------- #


def test_client_from_env_requires_both_variables(monkeypatch):
    monkeypatch.delenv("BHOONIDHI_USER", raising=False)
    monkeypatch.delenv("BHOONIDHI_PASSWORD", raising=False)
    with pytest.raises(BhoonidhiError) as excinfo:
        client_from_env()
    message = str(excinfo.value)
    assert "BHOONIDHI_USER" in message
    assert "BHOONIDHI_PASSWORD" in message


def test_client_from_env_reads_secrets(monkeypatch):
    monkeypatch.setenv("BHOONIDHI_USER", "alice")
    monkeypatch.setenv("BHOONIDHI_PASSWORD", "sekret-pw")
    client = client_from_env()
    assert client._user == "alice"
    assert client._password == "sekret-pw"
    client.close()  # no token yet -> no logout call


# --------------------------------------------------------------------------- #
# token lifecycle                                                             #
# --------------------------------------------------------------------------- #


def test_one_token_per_run_and_reuse(fake_http, clock):
    fake_http.add(token()).add(page([{"id": "a"}])).add(page([{"id": "b"}]))
    client = make_client(fake_http, clock)
    search(client)
    search(client)  # still inside expiry -> no second token request
    assert len(calls_to(fake_http, "/auth/token")) == 1
    assert len(calls_to(fake_http, "/data/search")) == 2
    payload = calls_to(fake_http, "/auth/token")[0][2]["json"]
    assert payload["grant_type"] == "password"
    assert payload["userId"] == "user-1"
    assert payload["password"] == "sekret-pw"


def test_refresh_grant_used_when_close_to_expiry(fake_http, clock):
    fake_http.add(token("acc-1", "ref-1", expires=1200))
    fake_http.add(page([{"id": "a"}]))
    fake_http.add(token("acc-2", "ref-2", expires=1200))
    fake_http.add(page([{"id": "b"}]))
    client = make_client(fake_http, clock)
    search(client)
    clock.advance(1200 - 30)  # inside the 60 s refresh margin
    search(client)
    token_calls = calls_to(fake_http, "/auth/token")
    assert len(token_calls) == 2
    assert token_calls[1][2]["json"]["grant_type"] == "refresh_token"
    assert token_calls[1][2]["json"]["refresh_token"] == "ref-1"


def test_session_expired_401_forces_one_refresh(fake_http, clock):
    fake_http.add(token("acc-1", "ref-1"))
    fake_http.add(FakeResponse(401, {"ErrorCode": "401", "Description": "expired"}))
    fake_http.add(token("acc-2", "ref-2"))
    fake_http.add(page([{"id": "a"}]))
    client = make_client(fake_http, clock)
    features = search(client)
    assert [feature["id"] for feature in features] == ["a"]
    assert len(calls_to(fake_http, "/auth/token")) == 2
    assert calls_to(fake_http, "/auth/token")[1][2]["json"]["grant_type"] == (
        "refresh_token"
    )
    assert clock.sleeps, "transient 401 should WAIT before retrying"


# --------------------------------------------------------------------------- #
# logout always runs                                                          #
# --------------------------------------------------------------------------- #


def test_close_posts_logout_with_refresh_token(fake_http, clock):
    fake_http.add(token())
    fake_http.add(page([{"id": "a"}]))
    fake_http.add(FakeResponse(200, {}))  # logout response
    with make_client(fake_http, clock) as client:
        search(client)  # acquires the token (and its refresh token)
    logout = calls_to(fake_http, "/auth/logout")
    assert len(logout) == 1
    assert logout[0][2]["headers"]["Authorization"] == "Bearer ref-1"


def test_close_without_token_makes_no_request(fake_http, clock):
    with make_client(fake_http, clock) as client:
        pass
    assert fake_http.calls == []


def test_logout_runs_even_when_search_fails(fake_http, clock):
    fake_http.add(token())
    for _delay in (0.0,) + BACKOFF_DELAYS_S:
        fake_http.add(FakeResponse(500, {"ErrorCode": "500", "Description": "down"}))
    fake_http.add(FakeResponse(200, {}))  # logout
    client = make_client(fake_http, clock)
    with pytest.raises(BhoonidhiError):
        with client:
            search(client)
    # WAIT backoff, never an immediate retry
    assert [round(s, 3) for s in clock.sleeps] == [
        round(delay, 3) for delay in BACKOFF_DELAYS_S
    ]
    logout = calls_to(fake_http, "/auth/logout")
    assert len(logout) == 1
    assert logout[0][2]["headers"]["Authorization"] == "Bearer ref-1"


# --------------------------------------------------------------------------- #
# token errors — operator action, never a retry loop                           #
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("status", "hint"),
    [
        (401, "wrong userId/password"),
        (403, "maximum sessions"),
        (429, "20/hour"),
    ],
)
def test_token_errors_raise_immediately(fake_http, clock, status, hint):
    fake_http.add(FakeResponse(status, {"ErrorCode": str(status), "Description": "x"}))
    client = make_client(fake_http, clock)
    with pytest.raises(BhoonidhiError) as excinfo:
        search(client)
    assert excinfo.value.status == status
    assert hint in str(excinfo.value)
    assert clock.sleeps == []  # no backoff for operator-action statuses
    assert "sekret-pw" not in str(excinfo.value)


# --------------------------------------------------------------------------- #
# search                                                                      #
# --------------------------------------------------------------------------- #


def test_search_posts_cql2_online_filter(fake_http, clock):
    fake_http.add(token()).add(page([]))
    make_client(fake_http, clock).search(
        collections=COLLECTIONS,
        datetime_range=RANGE,
        intersects=INTERSECTS,
    )
    body = calls_to(fake_http, "/data/search")[0][2]["json"]
    assert body["collections"] == COLLECTIONS
    assert body["datetime"] == RANGE
    assert body["intersects"] == INTERSECTS
    assert body["filter"] == {"args": [{"property": "Online"}, "Y"], "op": "eq"}
    assert body["filter-lang"] == "cql2-json"
    assert body["limit"] == 500


def test_search_follows_next_links(fake_http, clock):
    base = "https://bhoonidhi-api.nrsc.gov.in/data/search"
    fake_http.add(token())
    fake_http.add(page([{"id": "a"}], next_href=f"{base}?page=2"))
    fake_http.add(page([{"id": "b"}]))
    features = search(make_client(fake_http, clock))
    assert [feature["id"] for feature in features] == ["a", "b"]
    search_calls = calls_to(fake_http, "/data/search")
    assert len(search_calls) == 2
    assert search_calls[1][1] == f"{base}?page=2"
    # same body on every page
    assert search_calls[0][2]["json"] == search_calls[1][2]["json"]


def test_search_stops_on_repeated_next_link(fake_http, clock):
    base = "https://bhoonidhi-api.nrsc.gov.in/data/search"
    fake_http.add(token())
    fake_http.add(page([{"id": "a"}], next_href=base))  # points at itself
    features = search(make_client(fake_http, clock))
    assert [feature["id"] for feature in features] == ["a"]
    assert len(calls_to(fake_http, "/data/search")) == 1  # loop guard


def test_search_is_throttled_to_three_per_second(fake_http, clock):
    fake_http.add(token()).add(page([])).add(page([]))
    client = make_client(fake_http, clock)
    search(client)
    search(client)
    assert any(abs(sleep - 1.0 / 3.0) < 1e-9 for sleep in clock.sleeps)


def test_search_500_backs_off_then_succeeds(fake_http, clock):
    fake_http.add(token())
    for delay in (0.0,) + BACKOFF_DELAYS_S[:-1]:
        fake_http.add(FakeResponse(500, {"ErrorCode": "500", "Description": "x"}))
    fake_http.add(page([{"id": "a"}]))
    features = search(make_client(fake_http, clock))
    assert [feature["id"] for feature in features] == ["a"]
    assert clock.sleeps[0] == BACKOFF_DELAYS_S[0]


# --------------------------------------------------------------------------- #
# item lookup & download                                                      #
# --------------------------------------------------------------------------- #


def test_get_item_missing_raises_404(fake_http, clock):
    fake_http.add(token())
    fake_http.add(FakeResponse(404, {"ErrorCode": "404", "Description": "nope"}))
    with pytest.raises(BhoonidhiError) as excinfo:
        make_client(fake_http, clock).get_item(COLLECTIONS[0], "missing")
    assert excinfo.value.status == 404
    assert clock.sleeps == []


def test_download_streams_to_file(fake_http, clock, tmp_path):
    dest = tmp_path / "delivery.zip"
    fake_http.add(token())
    fake_http.add(FakeResponse(200, chunks=[b"hello", b"", b"world"]))
    make_client(fake_http, clock).download("item-1", COLLECTIONS[0], str(dest))
    assert dest.read_bytes() == b"helloworld"
    call = calls_to(fake_http, "/download")[0]
    assert call[2]["params"] == {"id": "item-1", "collection": COLLECTIONS[0]}
    assert call[2]["headers"]["Authorization"] == "Bearer acc-1"
    assert call[2]["stream"] is True


def test_download_retries_after_503_with_backoff(fake_http, clock, tmp_path):
    dest = tmp_path / "delivery.zip"
    fake_http.add(token())
    fake_http.add(FakeResponse(503, {"ErrorCode": "503", "Description": "busy"}))
    fake_http.add(FakeResponse(200, chunks=[b"data"]))
    make_client(fake_http, clock).download("item-1", COLLECTIONS[0], str(dest))
    assert dest.read_bytes() == b"data"
    assert clock.sleeps[0] == BACKOFF_DELAYS_S[0]


def test_download_404_hints_at_portal_ordering(fake_http, clock, tmp_path):
    dest = tmp_path / "delivery.zip"
    fake_http.add(token())
    fake_http.add(FakeResponse(404, {"ErrorCode": "404", "Description": "offline"}))
    with pytest.raises(BhoonidhiError) as excinfo:
        make_client(fake_http, clock).download("item-1", COLLECTIONS[0], str(dest))
    message = str(excinfo.value)
    assert excinfo.value.status == 404
    assert "Browse & Order" in message
    assert clock.sleeps == []  # not online is permanent: no WAIT loop
    assert not dest.exists()


# --------------------------------------------------------------------------- #
# defensive helpers                                                           #
# --------------------------------------------------------------------------- #


def test_error_message_formats_documented_body():
    message = error_message(
        {"ErrorCode": "E1", "Description": "quota", "Action": "wait"}, 429
    )
    assert "HTTP 429" in message
    assert "E1" in message
    assert "quota" in message
    assert "wait" in message


def test_error_message_falls_back_to_status_only():
    assert error_message(["unexpected"], 502) == "HTTP 502"
    assert error_message(None, 500) == "HTTP 500"


def test_next_link_defensive():
    assert next_link({"links": [{"rel": "next", "href": "/x"}]}) == "/x"
    assert next_link({"links": [{"rel": "prev", "href": "/x"}]}) is None
    assert next_link({"links": "nope"}) is None
    assert next_link(None) is None
    assert next_link({"links": [{"rel": "next"}]}) is None
