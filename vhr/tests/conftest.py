"""Test bootstrap: make vhr/ importable, keep GDAL out of unit tests, and
provide the fake HTTP layer used by the bhoonidhi/storage tests."""

from __future__ import annotations

import pathlib
import sys
from typing import Any

import pytest

VHR_DIR = pathlib.Path(__file__).resolve().parent.parent
if str(VHR_DIR) not in sys.path:
    sys.path.insert(0, str(VHR_DIR))


class FakeResponse:
    """Minimal requests.Response stand-in."""

    def __init__(
        self,
        status: int = 200,
        body: Any = None,
        *,
        chunks: list[bytes] | None = None,
        text: str = "",
    ) -> None:
        self.status_code = status
        self._body = body
        self._chunks = chunks if chunks is not None else [b""]
        self._text = text
        self.headers: dict[str, str] = {}
        self.closed = False

    def json(self) -> Any:
        if self._body is None:
            raise ValueError("response is not JSON")
        return self._body

    @property
    def text(self) -> str:
        if self._text:
            return self._text
        if isinstance(self._body, str):
            return self._body
        return ""

    def iter_content(self, chunk_size: int | None = None):  # noqa: ARG002
        for chunk in self._chunks:
            if chunk:
                yield chunk

    def close(self) -> None:
        self.closed = True


class FakeHttp:
    """Queued-response session: every request pops the next response.

    Queue items may be FakeResponse instances or callables
    (method, url, kwargs) -> FakeResponse for dynamic behaviour.
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self._queue: list[Any] = []

    def add(self, response: Any) -> "FakeHttp":
        self._queue.append(response)
        return self

    @property
    def remaining(self) -> int:
        return len(self._queue)

    def _next(self, method: str, url: str, kwargs: dict[str, Any]) -> FakeResponse:
        self.calls.append((method, url, kwargs))
        if not self._queue:
            raise AssertionError(f"unexpected request: {method} {url}")
        item = self._queue.pop(0)
        if callable(item):
            return item(method, url, kwargs)
        return item

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        return self._next(method.upper(), url, kwargs)

    def get(self, url: str, **kwargs: Any) -> FakeResponse:
        return self._next("GET", url, kwargs)

    def post(self, url: str, **kwargs: Any) -> FakeResponse:
        return self._next("POST", url, kwargs)


@pytest.fixture
def fake_http() -> FakeHttp:
    return FakeHttp()


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.t += seconds

    def advance(self, seconds: float) -> None:
        self.t += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()
