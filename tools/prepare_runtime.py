"""准备新客户端的独立运行时；仅拷贝允许清单中的依赖，不包含旧应用及账号。"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT.parent / "hongguo-desktop-maintain" / "_v109" / "extracted" / "backend"
CAPTURE_FILES = ("libc++_shared.so", "libmetasec_ml.so", "ms_16777218.bin")


def _copy_file(source, destination):
    if source.is_symlink() or not source.is_file():
        raise RuntimeError(f"允许清单的运行时文件缺失：{source.name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def _copy_tree(source, destination):
    if not source.is_dir() or source.is_symlink():
        raise RuntimeError(f"运行时目录缺失：{source.name}")
    for entry in source.rglob("*"):
        if entry.is_symlink():
            raise RuntimeError("运行时中发现符号链接")
        relative = entry.relative_to(source)
        # 构建缓存/测试记录不是运行时组成部分。
        if any(part in {"__pycache__", ".pytest_cache", "logs", ".git"} for part in relative.parts):
            continue
        if entry.is_file():
            _copy_file(entry, destination / relative)


def _download(url, target, sha256=None):
    request = urllib.request.Request(url, headers={"User-Agent": "hongguo-runtime-builder"})
    digest = hashlib.sha256()
    pending = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(request, timeout=60) as response, pending.open("wb") as output:
        while True:
            data = response.read(1024 * 1024)
            if not data:
                break
            output.write(data)
            digest.update(data)
    if sha256 and digest.hexdigest() != sha256:
        pending.unlink()
        raise RuntimeError("FFmpeg 运行时包摘要不一致")
    pending.replace(target)


def prepare_ffmpeg(runtime):
    target = runtime / "ffmpeg.exe"
    if target.is_file():
        return target
    source = shutil.which("ffmpeg")
    if source:
        _copy_file(Path(source), target)
        return target
    if importlib.util.find_spec("imageio_ffmpeg"):
        import imageio_ffmpeg
        _copy_file(Path(imageio_ffmpeg.get_ffmpeg_exe()), target)
        return target
    # PyPI 发布的 Windows wheel 自带静态 FFmpeg；只解出这一份 EXE。
    # 固定版本、校验 PyPI 摘要，下载/解压全部在工作区，没有 pip/TEMP 产物。
    build = runtime / ".build"
    build.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen("https://pypi.org/pypi/imageio-ffmpeg/0.6.0/json", timeout=20) as response:
        metadata = json.load(response)
    wheel = next(item for item in metadata["urls"]
                 if item["filename"].endswith("win_amd64.whl"))
    archive = build / "ffmpeg.whl"
    _download(wheel["url"], archive, wheel["digests"]["sha256"])
    with zipfile.ZipFile(archive) as package:
        members = [name for name in package.namelist()
                   if name.startswith("imageio_ffmpeg/binaries/") and name.endswith(".exe")]
        if len(members) != 1:
            raise RuntimeError("FFmpeg wheel 内容不符合预期")
        with package.open(members[0]) as source_file, target.open("wb") as output:
            shutil.copyfileobj(source_file, output)
    archive.unlink()  # 只清理本脚本刚下载的固定构建槽位。
    return target


def prepare(source=DEFAULT_SOURCE, runtime=None):
    source = Path(source).resolve()
    runtime = Path(runtime or ROOT / "runtime").resolve()
    if runtime == source or source in runtime.parents:
        raise ValueError("新运行时应在新客户端目录中")
    runtime.mkdir(parents=True, exist_ok=True)
    # 逐目录允许清单：Python/JRE 为只读依赖发行包，其它目录逐文件列出。
    for directory in ("python", "jre", "licenses"):
        _copy_tree(source / directory, runtime / directory)
    _copy_file(source / "sign" / "unidbg-sign.jar", runtime / "sign" / "unidbg-sign.jar")
    for name in CAPTURE_FILES:
        _copy_file(source / "capture" / "fq_oversea" / name,
                   runtime / "capture" / "fq_oversea" / name)
    # 媒体纯算法位于新 service/vendor，旧 frida 文件含采集入口/样例，不进入载荷。
    ffmpeg = prepare_ffmpeg(runtime)
    check = subprocess.run([str(runtime / "python" / "python.exe"), "-I", "-c",
                            "import av,fastapi,requests,Crypto; "
                            "print('runtime: Python/PyAV/FastAPI/requests/Crypto OK')"],
                           capture_output=True, text=True, timeout=30,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if check.returncode:
        raise RuntimeError("便携 Python 运行时依赖校验失败：" + check.stderr[:500])
    print(check.stdout.strip())
    check = subprocess.run([str(ffmpeg), "-version"], capture_output=True, text=True, timeout=10,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if check.returncode:
        raise RuntimeError("FFmpeg 无法启动")
    print(check.stdout.splitlines()[0])
    print("新运行时准备完成：", runtime)
    return runtime


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--runtime", type=Path, default=ROOT / "runtime")
    arguments = parser.parse_args()
    prepare(arguments.source, arguments.runtime)
