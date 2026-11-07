"""Build a frozen compatibility feed that transfers old clients to the two independent repos."""
import copy
import re
from urllib.parse import urlsplit

PC_REPOSITORY = "dddmiku/hongguo-desktop"
TV_REPOSITORY = "dddmiku/hongguo-tv"
LEGACY_REPOSITORY = "dddmiku/hongguo-desktop-releases"
BRIDGE_VERSION = "1.9.15"
_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")


def _platform(feed, key, repository, extension):
    platform = copy.deepcopy(feed.get("platforms", {}).get(key, {}))
    version = platform.get("version", "")
    digest, size = platform.get("sha256", ""), platform.get("size", 0)
    if not _VERSION.fullmatch(version) or not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("新仓库安装包版本或摘要缺失")
    if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= 512 * 1024**2:
        raise ValueError("新仓库安装包大小不正确")
    url = urlsplit(platform.get("url", ""))
    prefix = "/" + repository + "/releases/download/v" + version + "/"
    expected = ("hongguo-" + version + "-setup.exe" if extension == "exe"
                else "hongguo-tv-" + version + ".APK")
    if (url.scheme != "https" or url.netloc != "github.com" or url.path != prefix + expected
            or url.query or url.fragment):
        raise ValueError("安装包必须来自对应的新仓库已发布版本")
    return platform


def build_feed(pc_feed, tv_feed, notes, bridge_version=BRIDGE_VERSION):
    """The old comparison version stays higher; download URLs point to real independent releases."""
    if not _VERSION.fullmatch(bridge_version) or not bridge_version.startswith("1.9."):
        raise ValueError("旧 PC 兼容版本不正确")
    pc = _platform(pc_feed, "windows-x86_64", PC_REPOSITORY, "exe")
    tv = _platform(tv_feed, "android-tv", TV_REPOSITORY, "APK")
    if isinstance(tv.get("versionCode"), bool) or not isinstance(tv.get("versionCode"), int) or tv["versionCode"] < 1:
        raise ValueError("TV 覆盖安装版本码不正确")
    client_version = pc["version"]
    pc["version"] = bridge_version
    pc["clientVersion"] = client_version
    return {"version": bridge_version, "sha256": pc["sha256"], "notes": notes,
            "platforms": {"windows-x86_64": pc, "android-tv": tv},
            "migration": {"repository": "https://github.com/" + PC_REPOSITORY,
                          "targetVersion": client_version, "url": pc["url"],
                          "preservesLegacyData": True,
                          "tvRepository": "https://github.com/" + TV_REPOSITORY},
            "maintenance": {"active": False, "stoppedAt": "2026-11-07",
                            "replacementRepositories": {
                                "pc": "https://github.com/" + PC_REPOSITORY,
                                "tv": "https://github.com/" + TV_REPOSITORY}}}


def compatibility_asset(bridge_version=BRIDGE_VERSION):
    """Old download workers ignore feed.url and compose this exact, immutable alias themselves."""
    return ("https://github.com/" + LEGACY_REPOSITORY + "/releases/download/v" + bridge_version
            + "/hongguo-" + bridge_version + "-setup.exe")
