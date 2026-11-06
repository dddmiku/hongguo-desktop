"""Offline release resumption tests; never read credentials or access GitHub."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("publisher_under_test", ROOT / "tools/publish.py")
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class GitHub:
    def __init__(self, release=None):
        self.release = copy.deepcopy(release)
        self.calls = []
        self.fail_upload = False
        self.publish_after_lookup = False
        self.hidden_draft = False
        self.main_sha = "b" * 40
        self.tag_sha = "a" * 40

    def request(self, method, url, secret=None, data=None, raw=None, content_type=None):
        self.calls.append((method, url, copy.deepcopy(data)))
        if method == "GET" and "/releases/tags/" in url:
            if self.hidden_draft:
                return 404, {}
            value = copy.deepcopy(self.release)
            if self.publish_after_lookup and self.release:
                self.release["draft"] = False
            return (200, value) if value else (404, {})
        if method == "GET" and "/releases?" in url:
            return 200, [copy.deepcopy(self.release)] if self.release else []
        if method == "GET" and url.endswith("/branches/main"):
            return 200, {"commit": {"sha": self.main_sha}}
        if method == "GET" and "/git/ref/tags/" in url:
            return 200, {"object": {"sha": self.tag_sha, "type": "commit"}}
        if method == "PATCH" and "/git/refs/tags/" in url:
            self.tag_sha = data["sha"]
            return 200, {"object": {"sha": self.tag_sha, "type": "commit"}}
        if method == "GET" and url.endswith("/releases/42"):
            return 200, copy.deepcopy(self.release)
        if method == "GET" and url == "https://api.github.com/repos/" + P.REPO:
            return 200, {"default_branch": "main"}
        if method == "POST" and url.endswith("/releases"):
            self.release = {"id": 42, "tag_name": data["tag_name"], "draft": True,
                            "upload_url": "https://uploads.example/releases/42{?name}", "assets": []}
            return 201, copy.deepcopy(self.release)
        if method == "POST" and "?name=" in url:
            if self.fail_upload:
                return 503, {}
            name = url.split("?name=")[-1]
            asset = {"id": len(self.release["assets"]) + 100, "name": name, "size": len(raw),
                     "digest": "sha256:" + hashlib.sha256(raw).hexdigest(), "state": "uploaded"}
            self.release["assets"].append(asset)
            return 201, copy.deepcopy(asset)
        if method == "DELETE" and "/releases/assets/" in url:
            identifier = int(url.rsplit("/", 1)[-1])
            self.release["assets"] = [asset for asset in self.release["assets"] if asset["id"] != identifier]
            return 204, {}
        if method == "PATCH" and url.endswith("/releases/42"):
            self.release.update(data)
            self.release["html_url"] = "https://github.com/" + P.REPO + "/releases/tag/" + self.release["tag_name"]
            return 200, copy.deepcopy(self.release)
        raise AssertionError("Unexpected API path: " + method + " " + url)


class PublishTests(unittest.TestCase):
    def setUp(self):
        work = ROOT / "_work"
        work.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix="publisher-test-", dir=work)
        self.root = Path(self.directory.name)
        self.asset = self.root / "hongguo-1.1.0-setup.exe"
        self.asset.write_bytes(b"synthetic-installer")

    def tearDown(self):
        self.directory.cleanup()

    def release(self, draft=True, assets=None):
        return {"id": 42, "tag_name": "v1.1.0", "draft": draft,
                "upload_url": "https://uploads.example/releases/42{?name}", "assets": assets or []}

    def remote_asset(self, good=True):
        return {"id": 11, "name": self.asset.name, "size": self.asset.stat().st_size,
                "digest": "sha256:" + (hashlib.sha256(self.asset.read_bytes()).hexdigest() if good else "0" * 64),
                "state": "uploaded"}

    def run_release(self, github):
        with patch.object(P, "request", side_effect=github.request):
            return P.make_release(P.REPO, [self.asset], "new notes", "fixture", version="1.1.0")

    def test_new_release_is_verified_before_publication(self):
        github = GitHub()
        self.run_release(github)
        self.assertFalse(github.release["draft"])
        self.assertEqual(github.release["body"], "new notes")
        self.assertEqual(len(github.release["assets"]), 1)

    def test_existing_matching_draft_asset_is_reused(self):
        github = GitHub(self.release(assets=[self.remote_asset()]))
        self.run_release(github)
        self.assertFalse(any(method in ("DELETE", "POST") for method, _, _ in github.calls))
        self.assertFalse(github.release["draft"])

    def test_draft_hidden_by_tag_endpoint_is_found_in_listing(self):
        github = GitHub(self.release(assets=[self.remote_asset()]))
        github.hidden_draft = True
        self.run_release(github)
        self.assertFalse(any(method in ("DELETE", "POST") for method, _, _ in github.calls))
        self.assertFalse(github.release["draft"])

    def test_replacement_draft_tag_matches_pushed_source(self):
        github = GitHub(self.release(assets=[self.remote_asset()]))
        with patch.object(P, "request", side_effect=github.request):
            P.make_release(P.REPO, [self.asset], "notes", "fixture", version="1.1.0", source_commit=github.main_sha)
        self.assertEqual(github.tag_sha, github.main_sha)
        self.assertEqual(github.release["target_commitish"], github.main_sha)

    def test_unpushed_source_cannot_publish_draft(self):
        github = GitHub(self.release(assets=[self.remote_asset()]))
        with patch.object(P, "request", side_effect=github.request), self.assertRaisesRegex(RuntimeError, "尚未推送"):
            P.make_release(P.REPO, [self.asset], "notes", "fixture", version="1.1.0", source_commit="c" * 40)
        self.assertTrue(github.release["draft"])
        self.assertTrue(all(method == "GET" for method, _, _ in github.calls))

    def test_mismatching_draft_asset_is_replaced_and_other_assets_stay(self):
        other = {"id": 12, "name": "manual.txt", "size": 1, "digest": "unrelated"}
        github = GitHub(self.release(assets=[self.remote_asset(False), other]))
        self.run_release(github)
        self.assertEqual(len([asset for asset in github.release["assets"] if asset["name"] == self.asset.name]), 1)
        self.assertIn(other, github.release["assets"])
        self.assertTrue(any(method == "DELETE" and url.endswith("/11") for method, url, _ in github.calls))

    def test_public_version_is_never_modified(self):
        github = GitHub(self.release(draft=False, assets=[self.remote_asset(False)]))
        with self.assertRaisesRegex(RuntimeError, "拒绝覆盖"):
            self.run_release(github)
        self.assertEqual([call[0] for call in github.calls], ["GET"])

    def test_draft_that_became_public_is_not_modified(self):
        github = GitHub(self.release(assets=[self.remote_asset(False)]))
        github.publish_after_lookup = True
        with self.assertRaisesRegex(RuntimeError, "拒绝覆盖"):
            self.run_release(github)
        self.assertTrue(all(method == "GET" for method, _, _ in github.calls))

    def test_failed_upload_leaves_draft_for_retry(self):
        github = GitHub(self.release())
        github.fail_upload = True
        with self.assertRaisesRegex(RuntimeError, "上传资产失败"):
            self.run_release(github)
        self.assertTrue(github.release["draft"])
        self.assertFalse(any(method == "PATCH" for method, _, _ in github.calls))

    def test_matching_size_without_digest_is_not_trusted(self):
        remote = self.remote_asset()
        remote.pop("digest")
        github = GitHub(self.release(assets=[remote]))
        self.run_release(github)
        self.assertTrue(any(method == "DELETE" for method, _, _ in github.calls))

    def test_legacy_bridge_keeps_tv_and_targets_real_new_version(self):
        release_dir = self.root / "release"
        release_dir.mkdir()
        (release_dir / "hongguo-1.1.0-setup.exe").write_bytes(self.asset.read_bytes())
        (release_dir / "runtime-win-x64.zip").write_bytes(b"runtime-fixture")
        (self.root / "docs").mkdir()
        (self.root / "docs/release-notes.md").write_text("Release notes", encoding="utf-8")
        (self.root / "runtime-manifest.json").write_text(json.dumps({"version": "1.0.0"}), encoding="utf-8")
        tv = {"version": "1.0.9", "url": "https://github.com/fixture/tv.apk", "sha256": "a" * 64, "size": 900}
        previous = {"version": "1.9.10", "platforms": {"android-tv": tv, "windows-x86_64": {"version": "1.9.10"}}}
        old = copy.deepcopy(previous)
        with patch.object(P, "ROOT", self.root), patch.object(P, "VERSION", "1.1.0"), patch.object(P, "legacy_feed", return_value=previous), patch.object(P, "make_release") as make:
            P.publish("fixture", legacy=True)
        feed = json.loads((release_dir / "legacy-publish/latest.json").read_text(encoding="utf-8"))
        self.assertEqual(feed["platforms"]["android-tv"], tv)
        self.assertEqual(feed["version"], "1.9.11")
        self.assertEqual(feed["migration"]["targetVersion"], "1.1.0")
        self.assertIn("/v1.1.0/hongguo-1.1.0-setup.exe", feed["migration"]["url"])
        self.assertEqual(previous, old)
        self.assertEqual(make.call_args.kwargs["version"], "1.9.11")


if __name__ == "__main__":
    unittest.main()
