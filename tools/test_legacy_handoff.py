"""Exercise the legacy updater code paths with an isolated feed and identical migration payload."""
import copy
import base64
import hashlib
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from legacy_handoff import build_feed, compatibility_asset, BRIDGE_VERSION

DATA = b"same current PC installer bytes"
SHA = hashlib.sha256(DATA).hexdigest()
PC = {"platforms": {"windows-x86_64": {"version": "1.2.2", "sha256": SHA, "size": len(DATA),
    "url": "https://github.com/dddmiku/hongguo-desktop/releases/download/v1.2.2/hongguo-1.2.2-setup.exe"}}}
TV = {"platforms": {"android-tv": {"version": "1.1.3", "versionCode": 14, "size": 10, "sha256": "b"*64,
    "url": "https://github.com/dddmiku/hongguo-tv/releases/download/v1.1.3/hongguo-tv-1.1.3.APK"}}}
OLD = ROOT.parent / "hongguo-desktop-maintain/src/backend"


class Response:
    status_code = 200
    headers = {"content-length": str(len(DATA))}
    def __init__(self, result=None): self.result = result
    def json(self): return self.result
    def iter_content(self, size): return iter([DATA])
    def close(self): pass


class HandoffTests(unittest.TestCase):
    def test_feed_routes_pc_and_tv_to_separate_new_repositories(self):
        before_pc, before_tv = copy.deepcopy(PC), copy.deepcopy(TV)
        feed = build_feed(PC, TV, "迁移到新版")
        self.assertEqual(feed["version"], BRIDGE_VERSION)
        self.assertEqual(feed["platforms"]["windows-x86_64"]["url"], PC["platforms"]["windows-x86_64"]["url"])
        self.assertEqual(feed["migration"]["targetVersion"], "1.2.2")
        self.assertEqual(feed["platforms"]["android-tv"], TV["platforms"]["android-tv"])
        self.assertFalse(feed["maintenance"]["active"])
        self.assertEqual((PC, TV), (before_pc, before_tv))

    def test_mismatch_or_untrusted_download_cannot_be_published(self):
        for key, value in (("url", "https://example.com/setup.exe"), ("sha256", ""), ("size", True)):
            invalid = copy.deepcopy(PC); invalid["platforms"]["windows-x86_64"][key] = value
            with self.assertRaises(ValueError): build_feed(invalid, TV, "")

    def test_interrupted_publication_restores_archived_repository(self):
        spec = importlib.util.spec_from_file_location("handoff_publisher", ROOT/"tools/publish-legacy-handoff.py")
        publisher = importlib.util.module_from_spec(spec); spec.loader.exec_module(publisher)
        old_readme = {"content": base64.b64encode(b"Historical README").decode()}
        with patch.object(publisher.pub, "_find_release", return_value=None), patch.object(publisher, "read", return_value=old_readme), patch.object(publisher, "write_notice"), patch.object(publisher, "change") as change, patch.object(publisher.pub, "make_release", side_effect=TimeoutError("interrupted upload")):
            with self.assertRaises(TimeoutError):
                publisher.handoff(build_feed(PC,TV,""), "notice", [], {"archived":True,"default_branch":"master"}, "fixture")
        self.assertEqual(change.call_args_list[0].args, ("PATCH", "", {"archived":False}, "fixture"))
        self.assertEqual(change.call_args_list[-1].args, ("PATCH", "", {"archived":True}, "fixture"))

    def test_standard_publisher_and_handoff_agree_on_bridge_version(self):
        spec = importlib.util.spec_from_file_location("pc_publisher", ROOT/"tools/publish.py")
        publisher = importlib.util.module_from_spec(spec); spec.loader.exec_module(publisher)
        self.assertEqual(publisher.LEGACY_BRIDGE_VERSION, BRIDGE_VERSION)

    @unittest.skipUnless((OLD/"desktop_update.py").is_file(), "Legacy client source is not present in this checkout")
    def test_old_checker_reads_new_download_while_keeping_compatible_version(self):
        fake = types.ModuleType("hongguo")
        fake.http_request = lambda *args, **kwargs: Response(build_feed(PC, TV, ""))
        with patch.dict(sys.modules, {"hongguo": fake}):
            spec = importlib.util.spec_from_file_location("legacy_routing_checker", OLD/"desktop_update.py")
            checker = importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)
            for version in ("1.1.0", "1.4.0", "1.9.9", "1.9.14"):
                result = checker.check(local=version)
                self.assertTrue(result["ok"] and result["updateAvailable"])
                self.assertEqual(result["assetUrl"], PC["platforms"]["windows-x86_64"]["url"])
                self.assertEqual(result["latestVersion"], BRIDGE_VERSION)
                self.assertEqual(result["sha256"], SHA)

    @unittest.skipUnless((OLD/"desktop_update_download.py").is_file(), "Legacy downloader source is not present in this checkout")
    def test_hardcoded_old_downloader_gets_identical_new_installer_via_alias(self):
        fake = types.ModuleType("hongguo"); urls = []
        def request(method, url, **kwargs):
            urls.append(url)
            self.assertTrue(url.endswith(compatibility_asset()))
            return Response()
        fake.http_request = request
        (ROOT/"_work").mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=ROOT/"_work") as folder, patch.dict(os.environ, {"HONGGUO_DATA_DIR": folder}), patch.dict(sys.modules, {"hongguo": fake}):
            spec = importlib.util.spec_from_file_location("legacy_routing_downloader", OLD/"desktop_update_download.py")
            downloader = importlib.util.module_from_spec(spec); spec.loader.exec_module(downloader)
            task = {"version": BRIDGE_VERSION, "phase": "starting", "id": "routing-test", "cancelled": False}
            downloader._run(task, BRIDGE_VERSION, SHA)
            self.assertEqual(task["phase"], "done")
            self.assertEqual(Path(task["path"]).read_bytes(), DATA)
            self.assertEqual(task["sha256"], SHA)
            self.assertEqual(len(urls), 1)

    @unittest.skipUnless((OLD/"desktop_update.py").is_file(), "Legacy client source is not present in this checkout")
    def test_api_fallback_parses_same_compatibility_installer_and_digest(self):
        result = {"tag_name":"v"+BRIDGE_VERSION,"body":"Migration notice","assets":[{
            "name":"hongguo-"+BRIDGE_VERSION+"-setup.exe","browser_download_url":compatibility_asset(),
            "size":len(DATA),"digest":"sha256:"+SHA}]}
        fake = types.ModuleType("hongguo")
        fake.http_request = lambda *args, **kwargs: Response(result)
        with patch.dict(sys.modules, {"hongguo": fake}):
            spec = importlib.util.spec_from_file_location("legacy_api_fallback", OLD/"desktop_update.py")
            checker = importlib.util.module_from_spec(spec); spec.loader.exec_module(checker)
            actual = checker._from_api("1.9.9")
            self.assertTrue(actual["ok"])
            self.assertEqual(actual["latestVersion"],BRIDGE_VERSION)
            self.assertEqual(actual["assetUrl"],compatibility_asset())
            self.assertEqual(actual["assetSize"],len(DATA))
            self.assertEqual(actual["sha256"],SHA)


if __name__ == "__main__": unittest.main()
