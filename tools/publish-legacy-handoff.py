"""Prepare and publish the final legacy routing bridge; normal PC/TV releases stay independent."""
import argparse
import base64
import hashlib
import json
import shutil
import time

import publish as pub
from legacy_handoff import build_feed, BRIDGE_VERSION, LEGACY_REPOSITORY, PC_REPOSITORY, TV_REPOSITORY

API = "https://api.github.com/repos/" + LEGACY_REPOSITORY
OUT = pub.ROOT / "_work/retirement"


def read(url, secret=None):
    for attempt in range(3):
        try:
            status, result = pub.request("GET", url, secret)
            if status == 200:
                return result
        except (OSError, TimeoutError):
            pass
        if attempt < 2:
            time.sleep(.5)
    raise RuntimeError("无法读取迁移元数据：" + url)


def release_feed(repository, version, secret):
    base = "https://api.github.com/repos/" + repository
    repo = read(base, secret)
    if repo["private"] or repo["archived"]:
        raise RuntimeError("新仓库必须公开并处于维护状态")
    release = read(base + "/releases/tags/v" + version, secret)
    if release.get("draft") or release.get("prerelease") or release["tag_name"] != "v" + version:
        raise RuntimeError("迁移目标必须是已公开的正式版本")
    manifest = next(a for a in release["assets"] if a["name"] == "latest.json")
    feed = read(manifest["browser_download_url"])
    if isinstance(feed, bytes):
        feed = json.loads(feed)
    return release, feed


def prepare(pc_version, tv_version, secret):
    pc_release, pc_feed = release_feed(PC_REPOSITORY, pc_version, secret)
    tv_release, tv_feed = release_feed(TV_REPOSITORY, tv_version, secret)
    notes = (pub.ROOT / "docs/legacy-retirement.md").read_text(encoding="utf-8")
    feed = build_feed(pc_feed, tv_feed, notes)
    for key, version, release in (("windows-x86_64", pc_version, pc_release), ("android-tv", tv_version, tv_release)):
        platform = feed["platforms"][key]
        asset = next(a for a in release["assets"] if a["browser_download_url"] == platform["url"])
        if asset.get("digest") != "sha256:" + platform["sha256"] or asset["size"] != platform["size"]:
            raise RuntimeError("迁移清单与新仓库安装包不一致")
        if (platform.get("clientVersion") or platform["version"]) != version:
            raise RuntimeError("迁移目标版本不一致")
    installer = pub.ROOT / "release" / ("hongguo-" + pc_version + "-setup.exe")
    digest = hashlib.sha256(installer.read_bytes()).hexdigest()
    if digest != feed["sha256"] or installer.stat().st_size != feed["platforms"]["windows-x86_64"]["size"]:
        raise RuntimeError("本机安装包与已发布 PC 版本不一致")
    old_repo = read(API, secret)
    if old_repo["private"]:
        raise RuntimeError("旧入口不是公开仓库")
    previous = read(API + "/releases/latest", secret)
    prior = tuple(int(v) for v in previous["tag_name"].lstrip("v").split("."))
    if prior > tuple(int(v) for v in BRIDGE_VERSION.split(".")):
        raise RuntimeError("旧仓库已有更高版本，停止修改最新入口")
    OUT.mkdir(parents=True, exist_ok=True)
    bridge = OUT / ("hongguo-" + BRIDGE_VERSION + "-setup.exe")
    shutil.copyfile(installer, bridge)
    manifest = OUT / "latest.json"
    manifest.write_text(json.dumps(feed, ensure_ascii=False, indent=2), encoding="utf-8")
    notice = OUT / "MAINTENANCE_END.md"
    notice.write_text(notes, encoding="utf-8")
    checksums = OUT / "SHA256SUMS.txt"
    checksums.write_text(digest + "  " + bridge.name + "\n", encoding="utf-8")
    assets = [bridge, manifest, checksums, notice]
    plan = {"bridge": BRIDGE_VERSION, "previous": previous["tag_name"],
            "pcVersion": pc_version, "tvVersion": tv_version,
            "pcUrl": feed["platforms"]["windows-x86_64"]["url"],
            "tvUrl": feed["platforms"]["android-tv"]["url"],
            "assets": [{"name": a.name, "size": a.stat().st_size,
                        "sha256": hashlib.sha256(a.read_bytes()).hexdigest()} for a in assets]}
    (OUT / "handoff-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(plan, ensure_ascii=False), flush=True)
    return feed, notes, assets, old_repo


def change(method, path, data, secret):
    status, result = pub.request(method, API + path, secret, data=data)
    if status not in (200, 201):
        raise RuntimeError("迁移入口修改失败：HTTP " + str(status))
    return result


def write_notice(path, text, branch, secret):
    status, old = pub.request("GET", API + "/contents/" + path, secret)
    if status not in (200, 404):
        raise RuntimeError("无法核对停止维护说明")
    if status == 200 and base64.b64decode(old["content"]).decode("utf-8") == text:
        return
    body = {"message": "docs: route legacy updates to independent PC and TV releases",
            "content": base64.b64encode(text.encode("utf-8")).decode(), "branch": branch}
    if status == 200:
        body["sha"] = old["sha"]
    change("PUT", "/contents/" + path, body, secret)


def handoff(feed, notes, assets, old_repo, secret):
    tag = "v" + BRIDGE_VERSION
    existing = pub._find_release(LEGACY_REPOSITORY, tag, secret)
    if existing and not existing.get("draft"):
        for local in assets:
            asset = next(a for a in existing["assets"] if a["name"] == local.name)
            if not pub._asset_matches(asset, local):
                raise RuntimeError("兼容桥已公开且内容不同，拒绝覆盖")
    marker = "<!-- HONGGUO-MAINTENANCE-END -->"
    readme = read(API + "/contents/README.md", secret)
    old_text = base64.b64decode(readme["content"]).decode("utf-8")
    boundary = "\n---\n\n<details>"
    if marker in old_text:
        if boundary not in old_text:
            raise RuntimeError("旧 README 结构变化，停止覆盖历史说明")
        new_text = marker + "\n" + notes + boundary + old_text.split(boundary, 1)[1]
    else:
        new_text = marker + "\n" + notes + boundary + "\n<summary>历史项目说明</summary>\n\n" + old_text + "\n</details>\n"
    try:
        if old_repo.get("archived"):
            change("PATCH", "", {"archived": False}, secret)
        write_notice("README.md", new_text, old_repo["default_branch"], secret)
        write_notice("MAINTENANCE_END.md", notes, old_repo["default_branch"], secret)
        if not existing or existing.get("draft"):
            pub.make_release(LEGACY_REPOSITORY, assets, notes, secret, version=BRIDGE_VERSION,
                             title="停止维护 · 旧版本升级至独立 PC / TV 客户端")
        current = read(API + "/releases/latest", secret)
        if current["tag_name"] != tag:
            raise RuntimeError("旧更新入口没有指向最终兼容桥")
        actual = read(next(a for a in current["assets"] if a["name"] == "latest.json")["browser_download_url"])
        if isinstance(actual, bytes):
            actual = json.loads(actual)
        if actual != feed:
            raise RuntimeError("公开迁移清单与已审阅内容不同")
    finally:
        # A failed upload still leaves an archived repository and a recoverable draft.
        change("PATCH", "", {"archived": True}, secret)
    if not read(API, secret).get("archived"):
        raise RuntimeError("旧仓库归档状态未恢复")
    print("旧更新入口已迁移并重新归档：" + tag, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "publish"))
    parser.add_argument("--pc-version", required=True)
    parser.add_argument("--tv-version", required=True)
    args = parser.parse_args()
    secret = pub.token()
    prepared = prepare(args.pc_version, args.tv_version, secret)
    if args.action == "publish":
        handoff(*prepared, secret)
