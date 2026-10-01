"""`api._CachedStaticFiles`: hashed `assets/*` files must be cached
long-term/immutable (a content change always produces a new Vite-hashed
filename), while `index.html` and any other non-hashed top-level file must
always be revalidated (`Cache-Control: no-cache`) so a rebuilt frontend is
picked up on next load instead of being served stale from a browser's disk
cache — the bug flagged in the phase 03 report ("browser served stale
index.html until hard reload")."""

from __future__ import annotations

import asyncio
from pathlib import Path

from api import _CachedStaticFiles


def _build_fake_dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>v1</html>", encoding="utf-8")
    (dist / "assets" / "index-abc123.js").write_text("console.log(1)", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    return dist


def _get(static_files: _CachedStaticFiles, path: str):
    scope = {"type": "http", "method": "GET", "headers": []}
    return asyncio.run(static_files.get_response(path, scope))


def test_index_html_is_never_cached(tmp_path):
    dist = _build_fake_dist(tmp_path)
    static_files = _CachedStaticFiles(directory=str(dist), html=True)
    response = _get(static_files, "index.html")
    assert response.headers["Cache-Control"] == "no-cache"


def test_hashed_asset_is_cached_immutably_forever(tmp_path):
    dist = _build_fake_dist(tmp_path)
    static_files = _CachedStaticFiles(directory=str(dist), html=True)
    response = _get(static_files, "assets/index-abc123.js")
    assert response.headers["Cache-Control"] == "public, max-age=31536000, immutable"


def test_other_top_level_non_hashed_file_is_never_cached(tmp_path):
    """Only `assets/*` gets the long-cache treatment — any other top-level
    static file (e.g. `favicon.svg`, never content-hashed by Vite) must
    still be revalidated on every load, same as index.html."""
    dist = _build_fake_dist(tmp_path)
    static_files = _CachedStaticFiles(directory=str(dist), html=True)
    response = _get(static_files, "favicon.svg")
    assert response.headers["Cache-Control"] == "no-cache"
