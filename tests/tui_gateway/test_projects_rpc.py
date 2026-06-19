"""Tests for the projects.* JSON-RPC methods on the tui_gateway server."""

from __future__ import annotations

import os
import subprocess

import pytest

import tui_gateway.server as server


def _call(method, params=None):
    handler = server._methods[method]
    resp = handler(1, params or {})
    assert "error" not in resp, resp.get("error")
    return resp["result"]


def test_methods_registered():
    for m in (
        "projects.list",
        "projects.create",
        "projects.get",
        "projects.update",
        "projects.add_folder",
        "projects.remove_folder",
        "projects.set_primary",
        "projects.archive",
        "projects.set_active",
        "projects.for_cwd",
    ):
        assert m in server._methods


def test_for_cwd_is_a_long_handler():
    # git-probe handler must run off the dispatch thread.
    assert "projects.for_cwd" in server._LONG_HANDLERS


def test_create_list_roundtrip(tmp_path):
    created = _call("projects.create", {"name": "Demo", "folders": [str(tmp_path)], "use": True})
    assert created["project"]["slug"] == "demo"

    listing = _call("projects.list")
    assert [p["slug"] for p in listing["projects"]] == ["demo"]
    assert listing["active_id"] == created["project"]["id"]


def test_add_folder_and_for_cwd(tmp_path):
    folder = tmp_path / "repo"
    folder.mkdir()
    pid = _call("projects.create", {"name": "Repo", "folders": [str(folder)]})["project"]["id"]

    nested = folder / "src"
    nested.mkdir()
    resolved = _call("projects.for_cwd", {"cwd": str(nested)})
    assert resolved["project"]["id"] == pid
    # branch key is present (empty string when not a git repo).
    assert "branch" in resolved


def test_update_and_archive(tmp_path):
    pid = _call("projects.create", {"name": "Orig", "folders": [str(tmp_path)]})["project"]["id"]

    updated = _call("projects.update", {"id": pid, "name": "Renamed"})
    assert updated["project"]["name"] == "Renamed"

    payload = _call("projects.archive", {"id": pid})
    assert all(p["id"] != pid or p["archived"] for p in payload["projects"])


def test_get_unknown_returns_error():
    resp = server._methods["projects.get"](1, {"id": "nope"})
    assert "error" in resp


def test_delete_removes_project(tmp_path):
    pid = _call("projects.create", {"name": "Doomed", "folders": [str(tmp_path)]})["project"]["id"]
    payload = _call("projects.delete", {"id": pid})

    assert all(p["id"] != pid for p in payload["projects"])
    assert "projects.delete" in server._methods


def test_discover_repos_is_registered_long_handler():
    assert "projects.discover_repos" in server._methods
    assert "projects.discover_repos" in server._LONG_HANDLERS
    assert "projects.record_repos" in server._methods
    assert "projects.record_repos" in server._LONG_HANDLERS


def test_record_repos_persists_and_shows_zero_session_repo(tmp_path):
    repo = tmp_path / "fresh-repo"
    repo.mkdir()

    # Repo-first: a scanned repo with no hermes sessions still surfaces.
    _call("projects.record_repos", {"repos": [{"root": str(repo), "label": "fresh-repo"}]})

    by_label = {r["label"]: r for r in _call("projects.discover_repos")["repos"]}
    assert "fresh-repo" in by_label
    assert by_label["fresh-repo"]["sessions"] == 0


def test_discover_repos_from_full_history(tmp_path):
    repo = tmp_path / "myrepo"
    (repo / "src").mkdir(parents=True)
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
    plain = tmp_path / "plain"
    plain.mkdir()

    db = server._get_db()
    db.create_session("s1", "cli", cwd=str(repo))
    db.create_session("s2", "cli", cwd=str(repo / "src"))
    db.create_session("s3", "cli", cwd=str(plain))  # not a git repo → excluded

    repos = _call("projects.discover_repos")["repos"]
    by_label = {r["label"]: r for r in repos}

    assert "myrepo" in by_label
    assert by_label["myrepo"]["sessions"] == 2  # both repo cwds aggregate
    assert "plain" not in by_label  # non-git dir never promoted

    # The probe is persisted back onto the session rows (membership at the source).
    assert os.path.realpath(db.get_session("s1")["git_repo_root"]) == os.path.realpath(str(repo))
