"""发布独立客户端与旧版本迁移入口。凭据只在内存和 Git 子进程环境中。"""
import argparse
import copy
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OWNER = "dddmiku"
REPO = OWNER + "/hongguo-desktop"
LEGACY = OWNER + "/hongguo-desktop-releases"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
# 仅供旧 1.9.x 更新器比较与固定文件名使用，不是新客户端版本。
LEGACY_BRIDGE_VERSION = "1.9.14"


def token():
    class Credential(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD), ("TargetName", wintypes.LPWSTR),
            ("Comment", wintypes.LPWSTR), ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_byte)), ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]
    native = ctypes.WinDLL("advapi32", use_last_error=True)
    native.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.POINTER(Credential))]
    native.CredReadW.restype = wintypes.BOOL
    native.CredFree.argtypes = [ctypes.c_void_p]
    for name in ("git:https://github.com", "git:https://x-access-token@github.com"):
        ptr = ctypes.POINTER(Credential)()
        if native.CredReadW(name, 1, 0, ctypes.byref(ptr)):
            try:
                value = ctypes.string_at(ptr.contents.CredentialBlob, ptr.contents.CredentialBlobSize).decode("utf-16-le").strip()
                if ":" in value and not value.startswith(("ghp_", "github_pat_")):
                    value = value.rsplit(":", 1)[-1]
                if value:
                    return value
            finally:
                native.CredFree(ptr)
    raise RuntimeError("GitHub 凭据不存在")


def proxy():
    for port in (7897, 7890, 10809):
        try:
            with socket.create_connection(("127.0.0.1", port), .3):
                return "http://127.0.0.1:%d" % port
        except OSError:
            pass
    return None


def request(method, url, secret=None, data=None, raw=None, content_type=None):
    headers = {"User-Agent": "hongguo-desktop-publisher", "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if secret:
        headers["Authorization"] = "Bearer " + secret
    body = raw if raw is not None else json.dumps(data).encode() if data is not None else None
    if body is not None:
        headers["Content-Type"] = content_type or "application/json"
    route = proxy()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": route, "https": route} if route else {}))
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with opener.open(req, timeout=240 if raw is not None else 25) as response:
            content = response.read()
            try:
                return response.status, json.loads(content)
            except ValueError:
                return response.status, content
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read())
        except ValueError:
            return error.code, {}


def create_repo(secret):
    code, repo = request("GET", "https://api.github.com/repos/" + REPO, secret)
    if code == 404:
        code, repo = request("POST", "https://api.github.com/user/repos", secret, {
            "name": "hongguo-desktop", "description": "独立源码架构的红果桌面播放器 · Electron / React / TypeScript", "private": False, "has_issues": True})
    if code not in (200, 201) or repo.get("private"):
        raise RuntimeError("公开仓库创建或可见性核验失败：HTTP %s" % code)
    print("公开仓库：", repo["html_url"])


def push_source(secret):
    def git(*args, env=None):
        subprocess.run(["git", *args], cwd=ROOT, env=env, check=True, timeout=180)
    if not (ROOT / ".git").is_dir():
        git("init", "-b", "main")
        git("config", "user.name", "dddmiku")
        git("config", "user.email", "dddmiku@users.noreply.github.com")
        git("remote", "add", "origin", "https://github.com/" + REPO + ".git")
    git("add", ".")
    changed = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=ROOT).returncode
    if changed:
        git("commit", "-m", "fix: fullscreen playback, instant catalog and seamless episode transitions")
    env = dict(os.environ, HG_GITHUB_TOKEN=secret, GIT_ASKPASS=str(ROOT / "tools/git-askpass.cmd"), GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")
    route = proxy()
    args = ["-c", "credential.helper="]
    if route:
        args += ["-c", "http.proxy=" + route]
    git(*args, "push", "-u", "origin", "main", env=env)


def upload(repo, release, asset, secret):
    raw = asset.read_bytes()
    url = release["upload_url"].split("{")[0] + "?name=" + asset.name
    code, result = request("POST", url, secret, raw=raw, content_type="application/octet-stream")
    if code not in (200, 201) or result.get("size") != len(raw):
        raise RuntimeError("上传资产失败：%s HTTP %s" % (asset.name, code))
    if result.get("digest") and result["digest"] != "sha256:" + hashlib.sha256(raw).hexdigest():
        raise RuntimeError("上传资产摘要不符：" + asset.name)
    print("已上传：", asset.name, len(raw), "bytes")
    return result


def _draft_release(repo, release_id, tag, secret):
    """Read the current state before touching assets; never turn a public release back into a draft."""
    code, release = request("GET", "https://api.github.com/repos/%s/releases/%s" % (repo, release_id), secret)
    if code != 200 or release.get("id") != release_id or release.get("tag_name") != tag:
        raise RuntimeError("无法核对发布草稿，停止修改资产")
    if release.get("draft") is not True:
        raise RuntimeError("该版本已经公开，拒绝覆盖，请递增版本号")
    return release


def _asset_matches(remote, local):
    # Size alone cannot prove that a previous interrupted upload belongs to this build.
    return (remote.get("state", "uploaded") == "uploaded"
            and remote.get("size") == local.stat().st_size
            and remote.get("digest") == "sha256:" + hashlib.sha256(local.read_bytes()).hexdigest())


def _find_release(repo, tag, secret):
    code, release = request("GET", "https://api.github.com/repos/%s/releases/tags/%s" % (repo, tag), secret)
    if code == 200:
        return release
    if code != 404:
        raise RuntimeError("发布版本查询失败")
    # GitHub's tag endpoint returns 404 for drafts, including authenticated owners.
    # The authenticated release listing includes them and avoids duplicate creation.
    for page in range(1, 11):
        code, releases = request("GET", "https://api.github.com/repos/%s/releases?per_page=100&page=%s" % (repo, page), secret)
        if code != 200 or not isinstance(releases, list):
            raise RuntimeError("无法核对已有发布草稿")
        found = [item for item in releases if item.get("tag_name") == tag]
        if len(found) > 1:
            raise RuntimeError("同版本存在多个发布，停止修改")
        if found:
            return found[0]
        if len(releases) < 100:
            return None
    raise RuntimeError("发布列表过长，无法确定版本是否已存在")


def _align_draft_tag(repo, release, tag, source_commit, secret):
    """An unpublished replacement must expose the same source as its final installer."""
    base = "https://api.github.com/repos/" + repo
    code, main = request("GET", base + "/branches/main", secret)
    if code != 200 or main.get("commit", {}).get("sha") != source_commit:
        raise RuntimeError("最终源码尚未推送至 main，停止发布")
    code, ref = request("GET", base + "/git/ref/tags/" + tag, secret)
    if code == 200:
        old = ref.get("object", {})
        if old.get("type") != "commit":
            raise RuntimeError("已有标签不是轻量提交标签，停止修改")
        if old.get("sha") != source_commit:
            _draft_release(repo, release["id"], tag, secret)
            code, ref = request("PATCH", base + "/git/refs/tags/" + tag, secret,
                                {"sha": source_commit, "force": True})
            if code != 200 or ref.get("object", {}).get("sha") != source_commit:
                raise RuntimeError("草稿标签未能对齐最终源码")
            print("草稿源码标签已对齐：", old.get("sha", "")[:8], "->", source_commit[:8])
    elif code != 404:
        raise RuntimeError("无法核对草稿源码标签")
    _draft_release(repo, release["id"], tag, secret)
    return source_commit


def make_release(repo, assets, notes, secret, version=None, title=None, source_commit=None):
    version = version or VERSION
    tag = "v" + version
    existing = _find_release(repo, tag, secret)
    if existing is not None:
        if existing.get("draft") is not True:
            raise RuntimeError("该版本已经发布，拒绝覆盖，请递增版本号")
        release = existing
        print("继续尚未公开的草稿：", tag)
    else:
        code, metadata = request("GET", "https://api.github.com/repos/" + repo, secret)
        if code != 200:
            raise RuntimeError("无法查询发布仓库分支")
        code, release = request("POST", "https://api.github.com/repos/%s/releases" % repo, secret, {
            "tag_name": tag, "target_commitish": metadata.get("default_branch") or "main",
            "name": title or "红果桌面 " + version, "body": notes, "draft": True, "prerelease": False})
        if code != 201:
            raise RuntimeError("无法创建发布草稿：HTTP %s" % code)
    if len({asset.name for asset in assets}) != len(assets):
        raise RuntimeError("发布资产存在重复文件名")
    for asset in assets:
        if not asset.is_file():
            raise RuntimeError("发布资产缺失：" + asset.name)
        release = _draft_release(repo, release["id"], tag, secret)
        same = [remote for remote in release.get("assets", []) if remote.get("name") == asset.name]
        if len(same) == 1 and _asset_matches(same[0], asset):
            print("已复用通过摘要校验的草稿资产：", asset.name)
            continue
        for remote in same:
            _draft_release(repo, release["id"], tag, secret)
            code, _ = request("DELETE", "https://api.github.com/repos/%s/releases/assets/%s" % (repo, remote["id"]), secret)
            if code != 204:
                raise RuntimeError("无法替换草稿资产：" + asset.name)
        release = _draft_release(repo, release["id"], tag, secret)
        upload(repo, release, asset, secret)
    release = _draft_release(repo, release["id"], tag, secret)
    for asset in assets:
        uploaded = next((remote for remote in release.get("assets", []) if remote.get("name") == asset.name), None)
        # GitHub returns digest for release assets; no digest means this draft cannot be called verified.
        if uploaded is None or not _asset_matches(uploaded, asset):
            raise RuntimeError("草稿资产尚未校验完整，保留草稿供重试：" + asset.name)
    metadata = {"draft": False, "make_latest": "true", "name": title or "红果桌面 " + version,
                "body": notes, "prerelease": False}
    if source_commit:
        metadata["target_commitish"] = _align_draft_tag(repo, release, tag, source_commit, secret)
    code, result = request("PATCH", "https://api.github.com/repos/%s/releases/%s" % (repo, release["id"]), secret, metadata)
    if code != 200:
        raise RuntimeError("无法公开发布草稿")
    print("已发布：", result["html_url"])
    return result


def legacy_feed(secret):
    code, latest = request("GET", "https://api.github.com/repos/%s/releases/latest" % LEGACY, secret)
    if code != 200:
        raise RuntimeError("无法读取旧客户端平台配置")
    asset = next((a for a in latest.get("assets", []) if a["name"] == "latest.json"), None)
    if not asset:
        raise RuntimeError("旧平台配置缺失，停止迁移发布")
    code, feed = request("GET", asset["browser_download_url"])
    if code != 200:
        raise RuntimeError("旧平台配置读取失败")
    if isinstance(feed, bytes):
        feed = json.loads(feed)
    return feed


def publish(secret, legacy=False):
    out = ROOT / "release"
    installer = out / ("hongguo-%s-setup.exe" % VERSION)
    if not installer.is_file():
        raise RuntimeError("安装包尚未构建")
    archive = out / "runtime-win-x64.zip"
    if not archive.is_file():
        raise RuntimeError("可重建运行时尚未归档")
    previous = legacy_feed(secret)
    digest = hashlib.sha256(installer.read_bytes()).hexdigest()
    notes = (ROOT / "docs/release-notes.md").read_text(encoding="utf-8")
    platforms = copy.deepcopy(previous.get("platforms") or {})
    platforms["windows-x86_64"] = {"version": VERSION, "sha256": digest, "size": installer.stat().st_size,
        "url": "https://github.com/%s/releases/download/v%s/%s" % (REPO, VERSION, installer.name)}
    feed = {"version": VERSION, "sha256": digest, "notes": notes, "platforms": platforms,
            "migration": {"repository": "https://github.com/" + REPO, "preservesLegacyData": True}}
    if legacy:
        bridge_installer = out / ("hongguo-%s-setup.exe" % LEGACY_BRIDGE_VERSION)
        shutil.copyfile(installer, bridge_installer)
        platforms["windows-x86_64"] = {"version": LEGACY_BRIDGE_VERSION, "sha256": digest,
            "size": installer.stat().st_size,
            "url": "https://github.com/%s/releases/download/v%s/%s" % (LEGACY, LEGACY_BRIDGE_VERSION, bridge_installer.name)}
        feed["version"] = LEGACY_BRIDGE_VERSION
        feed["migration"].update({"targetVersion": VERSION,
            "url": "https://github.com/%s/releases/download/v%s/%s" % (REPO, VERSION, installer.name)})
        feed["notes"] = "旧客户端兼容迁移包：安装后使用全新红果桌面 " + VERSION + "。\n\n" + notes
    latest = out / ("legacy-latest.json" if legacy else "latest.json")
    latest.write_text(json.dumps(feed, ensure_ascii=False, indent=2), encoding="utf-8")
    checksums = out / ("LEGACY_SHA256SUMS.txt" if legacy else "SHA256SUMS.txt")
    runtime_manifest = json.loads((ROOT / "runtime-manifest.json").read_text(encoding="utf-8"))
    publish_runtime = runtime_manifest["version"] == VERSION
    public_assets = [installer, archive] if publish_runtime else [installer]
    checksums.write_text("\n".join(hashlib.sha256(a.read_bytes()).hexdigest() + "  " + a.name for a in ((bridge_installer,) if legacy else public_assets)), encoding="utf-8")
    if not legacy:
        if subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT).strip():
            raise RuntimeError("源码仍有未提交改动，停止发布")
        source_commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        make_release(REPO, [*public_assets, latest, checksums], notes, secret, source_commit=source_commit)
    else:
        migration_notes = "新版客户端已迁移到独立公开源码仓库 [hongguo-desktop](https://github.com/%s)。\n\n" % REPO
        migration_notes += "旧客户端可以直接检查更新并下载安装。首次启动会只读导入旧账号、历史和收藏，旧安装和数据保留。\n\n" + notes
        migration_notes += "\n\n兼容桥版本 %s 仅帮助旧 1.9.x 检测到迁移；新应用版本是 %s。" % (LEGACY_BRIDGE_VERSION, VERSION)
        # 旧 updater 固定读取名为 latest.json 的资源，不能发布 legacy-latest.json。
        staging = out / "legacy-publish"
        staging.mkdir(exist_ok=True)
        public_latest = staging / "latest.json"
        shutil.copyfile(latest, public_latest)
        make_release(LEGACY, [bridge_installer, public_latest, checksums], migration_notes, secret,
                     version=LEGACY_BRIDGE_VERSION, title="旧客户端迁移至红果桌面 " + VERSION)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["create", "push", "release", "legacy"])
    action = parser.parse_args().action
    secret = token()
    if action == "create":
        create_repo(secret)
    elif action == "push":
        create_repo(secret)
        push_source(secret)
    else:
        publish(secret, legacy=action == "legacy")
