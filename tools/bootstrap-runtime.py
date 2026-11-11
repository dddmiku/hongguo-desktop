"""Download and verify the published Windows runtime without using the system TEMP directory."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import stat
import sys
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "_work" / "runtime-bootstrap"
TARGET = ROOT / "runtime"
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_EXPANDED = 1536 * 1024 * 1024
MAX_ENTRIES = 40000
REQUIRED = ("python/python.exe", "jre/bin/java.exe", "sign/unidbg-sign.jar", "ffmpeg.exe",
            "sign/domestic-sign.jar", "capture/domestic/libmetasec_ml.so",
            "capture/domestic/libc++_shared.so", "capture/domestic/sdk-metadata.bin",
            "capture/fq_oversea/libc++_shared.so", "capture/fq_oversea/libmetasec_ml.so",
            "capture/fq_oversea/ms_16777218.bin")


def digest(file: Path) -> str:
    result = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def load_manifest(file: Path) -> dict:
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("无法读取 runtime-manifest.json，请使用包含运行时清单的正式源码版本") from error
    if not isinstance(data, dict) or not re.fullmatch(r"[0-9a-fA-F]{64}", str(data.get("sha256", ""))):
        raise RuntimeError("运行时清单缺少合法的 SHA-256")
    if not re.fullmatch(r"v?\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?", str(data.get("version", ""))):
        raise RuntimeError("运行时清单版本号不正确")
    url = urlparse(str(data.get("url", "")))
    if (url.scheme != "https" or url.hostname != "github.com" or url.username or url.password
            or url.port not in (None, 443) or url.query or url.fragment
            or not url.path.startswith("/dddmiku/hongguo-desktop/releases/download/")
            or not url.path.endswith("/runtime-win-x64.zip")):
        raise RuntimeError("运行时下载地址必须是本项目正式 GitHub Release 的 runtime-win-x64.zip")
    data["sha256"] = data["sha256"].lower()
    return data


def own_path(file: Path, parent: Path) -> Path:
    """Check both lexical containment and every existing component for reparse points."""
    resolved = file.resolve()
    if not resolved.is_relative_to(parent.resolve()) or file == parent:
        raise RuntimeError("运行时目标路径越过项目工作目录")
    current = file
    while current != parent:
        if current.exists() or current.is_symlink():
            info = current.lstat()
            if current.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
                raise RuntimeError("运行时目录含符号链接或重解析点，已停止操作")
        if current.parent == current:
            raise RuntimeError("运行时路径不在允许的目录中")
        current = current.parent
    return file


def download(manifest: dict, archive: Path) -> None:
    if archive.is_file() and digest(archive) == manifest["sha256"]:
        print("已复用校验通过的运行时 ZIP")
        return
    pending = archive.with_suffix(".zip.part")
    failures = []
    for prefix in ("https://v4.gh-proxy.org/", "https://gh-proxy.org/", "https://gh-proxy.com/", ""):
        print("下载运行时：", prefix or "GitHub 直连", flush=True)
        try:
            request = urllib.request.Request(prefix + manifest["url"], headers={"User-Agent": "hongguo-desktop-runtime-bootstrap"})
            total = 0
            checked = hashlib.sha256()
            with urllib.request.urlopen(request, timeout=60) as response, pending.open("wb") as output:
                if response.status != 200:
                    raise RuntimeError("下载服务返回异常状态")
                declared = int(response.headers.get("Content-Length", "0"))
                if declared > MAX_ARCHIVE:
                    raise RuntimeError("运行时 ZIP 超过大小上限")
                while True:
                    block = response.read(1024 * 1024)
                    if not block:
                        break
                    total += len(block)
                    if total > MAX_ARCHIVE:
                        raise RuntimeError("运行时 ZIP 超过大小上限")
                    output.write(block)
                    checked.update(block)
                if declared and total != declared:
                    raise RuntimeError("运行时下载不完整")
            if checked.hexdigest() != manifest["sha256"]:
                raise RuntimeError("运行时 SHA-256 不一致")
            pending.replace(archive)
            print(f"运行时 ZIP 已完整校验：{total / 1024 / 1024:.1f} MB")
            return
        except Exception as error:
            pending.unlink(missing_ok=True)
            failures.append(str(error)[:180] or type(error).__name__)
            print("当前下载源未成功，继续尝试下一个源", flush=True)
    raise RuntimeError("所有运行时下载源均失败（" + ", ".join(failures) + "），请稍后重试")


def member_path(info: zipfile.ZipInfo, strip_root: bool) -> PurePosixPath | None:
    name = info.filename.replace("\\", "/")
    if not name or name.startswith("/") or "\x00" in name:
        raise RuntimeError("ZIP 中含绝对路径或非法文件名")
    parts = name.rstrip("/").split("/")
    if any(not part or part in (".", "..") or part.endswith((".", " "))
           or any(char in part for char in '<>:"|?*') for part in parts):
        raise RuntimeError("ZIP 中含路径穿越或非法 Windows 文件名")
    if any(re.fullmatch(r"(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?", part) for part in parts):
        raise RuntimeError("ZIP 中含 Windows 保留文件名")
    if stat.S_ISLNK(info.external_attr >> 16) or (info.external_attr & 0xFFFF) & 0x400:
        raise RuntimeError("ZIP 中含符号链接或重解析点")
    if strip_root:
        if parts[0] != "runtime":
            raise RuntimeError("ZIP 运行时根目录不一致")
        parts = parts[1:]
        if not parts:
            return None
    relative = PurePosixPath(*parts)
    if relative.as_posix() == ".bootstrap-state.json":
        raise RuntimeError("ZIP 不能覆盖本地运行时校验状态")
    return relative


def verify_layout(directory: Path) -> None:
    for name in REQUIRED:
        file = own_path(directory / name, directory)
        if not file.is_file() or file.stat().st_size == 0:
            raise RuntimeError("运行时缺少必需文件：" + name)
    licenses = directory / "licenses"
    if not licenses.is_dir() or not any(file.is_file() for file in licenses.rglob("*")):
        raise RuntimeError("运行时缺少第三方许可证目录 licenses/")


def extract(archive: Path, staging: Path) -> dict[str, str]:
    """Validate all ZIP metadata before writing any member into the fixed staging slot."""
    hashes: dict[str, str] = {}
    with zipfile.ZipFile(archive) as package:
        members = package.infolist()
        if len(members) > MAX_ENTRIES or sum(member.file_size for member in members) > MAX_EXPANDED:
            raise RuntimeError("运行时 ZIP 展开大小或文件数量超过上限")
        strip_root = bool(members) and all(member.filename.replace("\\", "/").split("/", 1)[0] == "runtime" for member in members)
        plan = []
        seen = set()
        for member in members:
            if member.flag_bits & 1:
                raise RuntimeError("运行时 ZIP 不能包含加密成员")
            relative = member_path(member, strip_root)
            if relative is None:
                continue
            normalized = relative.as_posix().casefold()
            if normalized in seen:
                raise RuntimeError("运行时 ZIP 含重复文件路径")
            seen.add(normalized)
            destination = own_path(staging.joinpath(*relative.parts), staging)
            plan.append((member, relative, destination))
        own_path(staging, WORK)
        if staging.exists():
            shutil.rmtree(staging)
        staging.mkdir(parents=True)
        written = 0
        for member, relative, destination in plan:
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            checked = hashlib.sha256()
            size = 0
            with package.open(member) as source, destination.open("xb") as target:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    size += len(block)
                    written += len(block)
                    if size > member.file_size or written > MAX_EXPANDED:
                        raise RuntimeError("运行时 ZIP 实际展开大小超过上限")
                    target.write(block)
                    checked.update(block)
            if size != member.file_size:
                raise RuntimeError("运行时 ZIP 成员不完整")
            hashes[relative.as_posix()] = checked.hexdigest()
    verify_layout(staging)
    return hashes


def check(manifest: dict) -> None:
    own_path(TARGET, ROOT)
    verify_layout(TARGET)
    try:
        state = json.loads((TARGET / ".bootstrap-state.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("没有运行时校验状态，请先执行 bootstrap-runtime.py") from error
    if state.get("sha256") != manifest["sha256"] or state.get("version") != manifest["version"]:
        raise RuntimeError("已安装运行时与当前源码清单不一致，请重新执行 bootstrap-runtime.py")
    files = state.get("files")
    if not isinstance(files, dict) or not all(name in files for name in REQUIRED):
        raise RuntimeError("运行时校验状态缺少必需文件记录，请重新执行 bootstrap-runtime.py")
    for name, expected in files.items():
        if not isinstance(name, str) or not re.fullmatch(r"[0-9a-f]{64}", str(expected)):
            raise RuntimeError("运行时文件摘要记录不正确")
        relative = member_path(zipfile.ZipInfo(name), False)
        file = own_path(TARGET.joinpath(*relative.parts), TARGET)
        if not file.is_file() or digest(file) != expected:
            raise RuntimeError("运行时文件校验失败：" + name)
    print("运行时版本与全部已记录文件校验通过：", manifest["version"])


def bootstrap(manifest: dict) -> None:
    own_path(WORK, ROOT)
    own_path(TARGET, ROOT)
    WORK.mkdir(parents=True, exist_ok=True)
    archive = own_path(WORK / "runtime-win-x64.zip", WORK)
    download(manifest, archive)
    # Even cached archives are hashed byte for byte immediately before extraction.
    if digest(archive) != manifest["sha256"]:
        raise RuntimeError("运行时 ZIP 校验失败")
    staging = own_path(WORK / "staging", WORK)
    files = extract(archive, staging)
    (staging / ".bootstrap-state.json").write_text(json.dumps({"version": manifest["version"], "sha256": manifest["sha256"], "files": files}, ensure_ascii=False, indent=2), encoding="utf-8")
    previous = own_path(WORK / "previous", WORK)
    # These are fixed, script-owned slots. Never accumulate dated backups.
    if previous.exists():
        shutil.rmtree(previous)
    if TARGET.exists():
        TARGET.rename(previous)
    try:
        staging.rename(TARGET)
    except Exception:
        if previous.exists() and not TARGET.exists():
            previous.rename(TARGET)
        raise
    print("运行时已安装到：", TARGET)
    print("固定缓存与上一份运行时位于 _work/runtime-bootstrap，可在退出客户端后清理。")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "runtime-manifest.json")
    parser.add_argument("--check", action="store_true", help="Only verify the installed runtime against its source manifest")
    args = parser.parse_args()
    try:
        manifest = load_manifest(args.manifest)
        check(manifest) if args.check else bootstrap(manifest)
    except (RuntimeError, OSError, ValueError, zipfile.BadZipFile) as error:
        print("运行时准备失败：", str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
