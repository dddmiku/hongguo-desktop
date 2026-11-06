"""归档自有 runtime 目录，生成供源码重建使用的 SHA256 清单。"""
from pathlib import Path
import hashlib
import json
import zipfile
ROOT = Path(__file__).resolve().parents[1]
runtime = ROOT / "runtime"
out = ROOT / "release"
out.mkdir(exist_ok=True)
archive = out / "runtime-win-x64.zip"
def include(file):
    rel=file.relative_to(runtime).as_posix()
    return not ("__pycache__" in file.parts or file.suffix==".pyc" or rel.startswith(".build/")
                or (rel.startswith("licenses/") and ("review" in file.name or "candidate" in file.name
                    or file.name.startswith("release-derivation-") or rel.startswith("licenses/application-notices/")
                    or file.name in ("application-dependencies.json","README.txt"))))
with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zipped:
    for file in sorted(runtime.rglob("*")):
        if file.is_symlink():
            raise RuntimeError("运行时不能包含链接")
        if file.is_file() and include(file):
            zipped.write(file, file.relative_to(runtime).as_posix())
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
version = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
(ROOT / "runtime-manifest.json").write_text(json.dumps({"version": version, "url": "https://github.com/dddmiku/hongguo-desktop/releases/download/v%s/runtime-win-x64.zip" % version, "sha256": digest, "size": archive.stat().st_size}, indent=2), encoding="utf-8")
print(json.dumps({"archive": archive.name, "size": archive.stat().st_size, "sha256": digest}))
