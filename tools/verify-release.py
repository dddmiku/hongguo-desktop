"""Check public update routing and optional real legacy downloads without installing or writing accounts."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
import sys
import types
from unittest.mock import patch

import requests
import publish as pub
from legacy_handoff import BRIDGE_VERSION, PC_REPOSITORY, TV_REPOSITORY, LEGACY_REPOSITORY, compatibility_asset


def read(url, secret=None):
    status, value = pub.request("GET", url, secret)
    if status != 200:
        raise RuntimeError("无法读取公开更新信息：HTTP " + str(status))
    return json.loads(value) if isinstance(value, bytes) else value


def release(repository, version, secret):
    result = read("https://api.github.com/repos/" + repository + "/releases/tags/v" + version, secret)
    assert result["tag_name"] == "v" + version and not result["draft"] and not result["prerelease"]
    return result


def feed(result):
    return read(next(a for a in result["assets"] if a["name"] == "latest.json")["browser_download_url"])


def load_old_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify(download=False):
    secret = pub.token()
    old_repo = read("https://api.github.com/repos/" + LEGACY_REPOSITORY, secret)
    assert old_repo["archived"] and not old_repo["private"]
    bridge_release = release(LEGACY_REPOSITORY, BRIDGE_VERSION, secret)
    current = read("https://api.github.com/repos/" + LEGACY_REPOSITORY + "/releases/latest", secret)
    assert current["tag_name"] == bridge_release["tag_name"]
    active = read("https://github.com/" + LEGACY_REPOSITORY + "/releases/latest/download/latest.json")
    assert active == feed(bridge_release) and active["version"] == BRIDGE_VERSION
    pc, tv = active["platforms"]["windows-x86_64"], active["platforms"]["android-tv"]
    target_version = active["migration"]["targetVersion"]
    pc_release, tv_release = release(PC_REPOSITORY, target_version, secret), release(TV_REPOSITORY, tv["version"], secret)
    pc_feed, tv_feed = feed(pc_release), feed(tv_release)
    source = pc_feed["platforms"]["windows-x86_64"]
    assert pc["version"] == BRIDGE_VERSION and pc["clientVersion"] == target_version
    assert pc["url"] == source["url"] == active["migration"]["url"]
    assert pc["url"].startswith("https://github.com/" + PC_REPOSITORY + "/releases/download/v" + target_version + "/")
    assert pc["sha256"] == source["sha256"] == active["sha256"] and pc["size"] == source["size"]
    assert tv == tv_feed["platforms"]["android-tv"]
    assert tv["url"].startswith("https://github.com/" + TV_REPOSITORY + "/releases/download/v" + tv["version"] + "/")
    assert not active["maintenance"]["active"] and tv["versionCode"] > 13
    for result, platform in ((pc_release, pc), (tv_release, tv)):
        asset = next(a for a in result["assets"] if a["browser_download_url"] == platform["url"])
        assert asset["size"] == platform["size"] and asset["digest"] == "sha256:" + platform["sha256"]
    alias = next(a for a in bridge_release["assets"] if a["browser_download_url"] == compatibility_asset())
    assert alias["size"] == pc["size"] and alias["digest"] == "sha256:" + pc["sha256"]
    for repository in (PC_REPOSITORY, TV_REPOSITORY):
        repo = read("https://api.github.com/repos/" + repository, secret)
        assert not repo["private"] and not repo["archived"]
    notice = read("https://api.github.com/repos/" + LEGACY_REPOSITORY + "/contents/MAINTENANCE_END.md", secret)
    notice_text = base64.b64decode(notice["content"]).decode("utf-8")
    assert PC_REPOSITORY in notice_text and TV_REPOSITORY in notice_text and BRIDGE_VERSION in notice_text
    # The final handoff stays fixed after the normal PC version advances.
    if pub.VERSION == target_version:
        local = pub.ROOT / "release" / ("hongguo-" + target_version + "-setup.exe")
        assert hashlib.sha256(local.read_bytes()).hexdigest() == pc["sha256"]
    old = pub.ROOT.parent / "hongguo-desktop-maintain/src/backend"
    if not (old / "desktop_update.py").is_file():
        raise RuntimeError("真实旧更新器源码不可用，未验证旧客户端解析")
    route = pub.proxy()
    network = requests.Session()
    network.trust_env = False
    if route:
        network.proxies.update({"http": route, "https": route})
    fake = types.ModuleType("hongguo")
    fake.http_request = network.request
    report = {"archived": True, "bridge": BRIDGE_VERSION, "pcVersion": target_version,
              "tvVersion": tv["version"], "pcUrl": pc["url"], "tvUrl": tv["url"], "sha256": pc["sha256"]}
    with patch.dict(sys.modules, {"hongguo": fake}):
        checker = load_old_module("legacy_live_checker", old / "desktop_update.py")
        checks = []
        for version in ("1.1.0", "1.4.0", "1.9.9", "1.9.14"):
            result = checker.check(local=version)
            assert result["ok"] and result["updateAvailable"] and result["latestVersion"] == BRIDGE_VERSION, "旧更新器尚未读到最终迁移版本"
            assert result["assetUrl"] == pc["url"] and result["assetSize"] == pc["size"] and result["sha256"] == pc["sha256"]
            checks.append(version)
        print("公开静态清单与真实旧更新器解析已通过校验", flush=True)
        fallback = checker._from_api("1.9.9")
        if not fallback.get("ok") and "被限流（HTTP 403）" in fallback.get("error", ""):
            report["apiFallback"] = {"verified": False, "error": fallback["error"]}
        else:
            assert fallback["ok"] and fallback["latestVersion"] == BRIDGE_VERSION and fallback["sha256"] == pc["sha256"]
            assert fallback["assetUrl"] == compatibility_asset()
            report["apiFallback"] = {"verified": True}
        report["comparedLocalVersions"] = checks
        if download:
            data = pub.ROOT / "_work/retirement/download-verification"
            data.mkdir(parents=True, exist_ok=True)
            with patch.dict(os.environ, {"HONGGUO_DATA_DIR": str(data)}):
                worker = load_old_module("legacy_live_downloader", old / "desktop_update_download.py")
                task = {"version": BRIDGE_VERSION, "phase": "starting", "id": "legacy-handoff-verification", "cancelled": False}
                print("正在通过真实旧下载器下载并校验兼容安装包……", flush=True)
                worker._run(task, BRIDGE_VERSION, pc["sha256"])
                assert task["phase"] == "done", task.get("error")
                assert task["size"] == pc["size"] and task["sha256"] == pc["sha256"]
                report["realLegacyDownload"] = {"source": task["source"], "size": task["size"], "sha256": task["sha256"]}
            response = network.get(tv["url"], stream=True, timeout=60)
            response.raise_for_status()
            digest, size = hashlib.sha256(), 0
            with response:
                for chunk in response.iter_content(1 << 18):
                    digest.update(chunk)
                    size += len(chunk)
            assert size == tv["size"] and digest.hexdigest() == tv["sha256"]
            report["realTvDownload"] = {"size": size, "sha256": digest.hexdigest()}
    network.close()
    output = pub.ROOT / "_work/retirement/verification.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--download", action="store_true", help="Verify actual old downloads; never launch installers")
    verify(parser.parse_args().download)
