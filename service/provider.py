"""Content and account boundary for the new desktop client.

The vendor directory contains protocol leaves only. This module owns models,
cache policy, request budgets, cancellation and the explicit cloud write policy.
"""
from __future__ import annotations

import base64
from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timezone
import ctypes
import hashlib
import hmac
import importlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import requests
import danmaku as danmaku_contract
from favorite_sync import set_favorite as reconcile_favorite
from progress_contract import build_playback_progress_item, build_progress_item, epoch_seconds, mobile_position_seconds
from source_download import SourceDownloader
from seasons import SeasonResolver
from search import SearchRows, search_series
from qr_login import QrLoginManager, QrLoginError


GENRES = {"short_play", "comic_series", "ai_series"}
QUALITIES = {"auto", "1080p", "720p", "540p", "480p", "360p"}
SORTS = {"online_time", "hot_score", "hot_collect"}
CODECS = {"bytevc1", "hevc", "h265", "hvc1", "avc1", "h264"}


# Fixed protocol salt for the official playback URL envelope; no account material.
_PROTOCOL_SALT = bytes.fromhex('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58')


def decode_playback_url(value_base64, seed_base64) -> str | None:
    """Decode an official URL envelope; return None on malformed/unsupported input."""
    if not isinstance(value_base64, str) or not isinstance(seed_base64, str):
        return None
    from Crypto.Cipher import AES
    import struct
    import binascii
    try:
        cipher = base64.b64decode(''.join(value_base64.split()), validate=True)
        seed = base64.b64decode(''.join(seed_base64.split()), validate=True)
        if len(seed) != 32 or len(cipher) < 20 or (len(cipher) - 4) % 16:
            return None
        if struct.unpack('<HH', cipher[:4]) != (0x00A8, 1):
            return None
        first = hashlib.sha512(seed).digest()
        material = hashlib.sha512(first + _PROTOCOL_SALT).digest()
        plain = AES.new(material[:16], AES.MODE_CBC, material[16:32]).decrypt(cipher[4:])
        padding = plain[-1]
        if not 1 <= padding <= 16 or plain[-padding:] != bytes([padding]) * padding:
            return None
        text = plain[:-padding].decode('utf-8', errors='strict')
        return text or None
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        return None


class ProviderError(Exception):
    def __init__(self, code: str, message: str, status: int = 502):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def identifier(value) -> str:
    text = str(value or "")
    if not re.fullmatch(r"[0-9]{8,24}", text):
        raise ProviderError("INPUT_INVALID", "剧集标识不正确", 400)
    return text


def number(value, default=0):
    try:
        return max(0, int(value or default))
    except (TypeError, ValueError, OverflowError):
        return default


def normalize_series(raw: dict) -> dict:
    sid = identifier(raw.get("id") or raw.get("seriesId") or raw.get("series_id") or raw.get("book_id"))
    tags = raw.get("tags") or raw.get("category") or []
    if isinstance(tags, str):
        tags = [part.strip() for part in tags.split("/") if part.strip()]
    actors = raw.get("actors") or raw.get("celebrities") or []
    actors = [str(item.get("演员") or item.get("nickname") or "") if isinstance(item, dict)
              else str(item) for item in actors] if isinstance(actors, list) else []
    cover = str(raw.get("cover") or raw.get("thumb_url") or "")
    return {"id": sid, "title": str(raw.get("title") or raw.get("book_name") or "未命名短剧")[:200],
            "cover": cover if cover.startswith("https://") else "", "intro": str(raw.get("intro") or "")[:2000],
            "totalEpisodes": number(raw.get("totalEpisodes") or raw.get("episodeCount") or raw.get("episode_cnt")),
            "tags": [str(item)[:80] for item in tags[:12]] if isinstance(tags, list) else [],
            "actors": [actor for actor in actors if actor][:20], "score": str(raw.get("score") or "")[:20]}


class SessionVault:
    """Current-user DPAPI storage; plaintext credentials never reach disk."""
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.RLock()

    @staticmethod
    def _crypt(data, decrypt=False):
        if os.name != "nt":
            raise ProviderError("ACCOUNT_STORAGE_UNAVAILABLE", "当前系统无法安全保存登录态", 503)

        class Blob(ctypes.Structure):
            _fields_ = [("size", ctypes.c_uint32), ("data", ctypes.POINTER(ctypes.c_ubyte))]

        buffer = ctypes.create_string_buffer(data)
        source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
        output = Blob()
        library = ctypes.WinDLL("crypt32.dll", winmode=0x00000800, use_last_error=True)
        free = ctypes.WinDLL("kernel32.dll", winmode=0x00000800).LocalFree
        free.argtypes, free.restype = [ctypes.c_void_p], ctypes.c_void_p
        if decrypt:
            operation = library.CryptUnprotectData
            operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
        else:
            operation = library.CryptProtectData
            operation.argtypes = [ctypes.POINTER(Blob), ctypes.c_wchar_p, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(Blob)]
        operation.restype = ctypes.c_int
        ok = operation(ctypes.byref(source), None if decrypt else "Hongguo Desktop", None, None, None,
                       1, ctypes.byref(output))  # CRYPTPROTECT_UI_FORBIDDEN
        if not ok:
            raise ProviderError("ACCOUNT_STORAGE_FAILED", "无法安全读取或保存登录态", 500)
        try:
            return ctypes.string_at(output.data, output.size)
        finally:
            free(output.data)

    def load(self):
        with self.lock:
            try:
                encrypted = self.path.read_bytes()
                if not encrypted.startswith(b"HGV1") or len(encrypted) > 131072:
                    return {}
                value = json.loads(self._crypt(encrypted[4:], decrypt=True))
                return value if isinstance(value, dict) else {}
            except (OSError, ValueError, ProviderError):
                return {}

    def save(self, value):
        with self.lock:
            serialized = json.dumps(value or {}, ensure_ascii=False).encode("utf-8")
            if len(serialized) > 65536:
                raise ProviderError("ACCOUNT_STORAGE_FAILED", "登录态内容过大，未能保存", 500)
            encrypted = b"HGV1" + self._crypt(serialized)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            pending = self.path.with_suffix(self.path.suffix + ".partial")
            try:
                pending.write_bytes(encrypted)
                os.replace(pending, self.path)
            except OSError:
                raise ProviderError("ACCOUNT_STORAGE_FAILED", "无法安全保存登录态", 500) from None
            finally:
                pending.unlink(missing_ok=True)
            return dict(value or {})

    def clear(self):
        return self.save({})


class RequestCache:
    """Bounded TTL cache with one fetch per key and no cached failures."""
    def __init__(self, capacity=256):
        self.capacity = capacity
        self.values = OrderedDict()
        self.running = set()
        self.condition = threading.Condition()

    def get(self, key, ttl, loader, *, cacheable=None):
        with self.condition:
            while key in self.running:
                self.condition.wait(timeout=30)
            entry = self.values.get(key)
            if entry and entry[0] > time.monotonic():
                self.values.move_to_end(key)
                return entry[1]
            self.running.add(key)
        try:
            value = loader()
            if cacheable is None or cacheable(value):
                with self.condition:
                    self.values[key] = (time.monotonic() + ttl, value)
                    self.values.move_to_end(key)
                    while len(self.values) > self.capacity:
                        self.values.popitem(last=False)
            return value
        finally:
            with self.condition:
                self.running.discard(key)
                self.condition.notify_all()

    def clear(self):
        with self.condition:
            self.values.clear()

    def invalidate(self, key):
        with self.condition:
            self.values.pop(key, None)


class CatalogCache:
    """Public discovery only: validated disk cache, single refresh and stale-on-error."""
    def __init__(self, path, capacity=12, max_age=3 * 86400):
        self.path, self.capacity, self.max_age = Path(path), capacity, max_age
        self.values = OrderedDict()
        self.running, self.errors, self.retry_at = set(), {}, {}
        self.condition = threading.Condition()
        self.closed = False
        try:
            if self.path.stat().st_size > 1024 * 1024:
                return
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            if saved.get("schema") != 1 or not isinstance(saved.get("entries"), dict):
                return
            now = time.time()
            for key, entry in list(saved["entries"].items())[-capacity:]:
                if key not in {"discover:" + genre for genre in GENRES} or not isinstance(entry, dict):
                    continue
                at = float(entry.get("at", 0))
                if not math.isfinite(at) or not 0 <= now - at <= max_age:
                    continue
                items = self._items(entry.get("items"))
                if items:
                    self.values[key] = {"at": at, "items": items}
        except (OSError, ValueError, TypeError, AttributeError):
            pass

    @staticmethod
    def _items(rows):
        if not isinstance(rows, list):
            return []
        values, seen = [], set()
        for row in rows[:100]:
            if not isinstance(row, dict):
                continue
            try:
                value = normalize_series(row)
            except (ProviderError, TypeError, ValueError):
                continue
            if value["id"] not in seen:
                seen.add(value["id"])
                values.append(value)
        return values

    def _persist(self):
        now = time.time()
        for key in list(self.values):
            if now - self.values[key]["at"] > self.max_age:
                self.values.pop(key, None)
        while len(self.values) > self.capacity:
            self.values.popitem(last=False)
        pending = self.path.with_suffix(".json.part")
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            pending.write_text(json.dumps({"schema": 1, "entries": self.values}, ensure_ascii=False), encoding="utf-8")
            pending.replace(self.path)
        except OSError:
            # Discovery remains usable when the cache directory cannot be written.
            pass
        finally:
            try:
                pending.unlink(missing_ok=True)
            except OSError:
                pass

    def _view(self, key, cached=True):
        entry = self.values[key]
        return {"items": entry["items"], "cached": cached,
                "stale": time.time() - entry["at"] >= 120,
                "updating": key in self.running, "updatedAt": entry["at"],
                **({"warning": self.errors[key]} if key in self.errors else {})}

    def _fetch(self, key, loader):
        try:
            items = self._items(loader())
            if not items:
                raise ProviderError("CATALOG_EMPTY", "当前片单暂时不可用，请稍后刷新")
            with self.condition:
                if self.closed:
                    raise ProviderError("SERVICE_STOPPING", "播放服务正在退出", 503)
                self.values[key] = {"at": time.time(), "items": items}
                self.values.move_to_end(key)
                self.errors.pop(key, None)
                self.retry_at.pop(key, None)
                self._persist()
        except Exception:
            with self.condition:
                self.errors[key] = "片单更新暂时失败，已保留上次内容"
                self.retry_at[key] = time.monotonic() + 10
            raise
        finally:
            with self.condition:
                self.running.discard(key)
                self.condition.notify_all()

    def get(self, key, loader, refresh=False):
        with self.condition:
            if self.closed:
                raise ProviderError("SERVICE_STOPPING", "播放服务正在退出", 503)
            entry = self.values.get(key)
            if entry and time.time() - entry["at"] > self.max_age:
                self.values.pop(key, None)
                entry = None
            if entry and not refresh:
                self.values.move_to_end(key)
                if (time.time() - entry["at"] >= 120 and key not in self.running
                        and time.monotonic() >= self.retry_at.get(key, 0)):
                    self.running.add(key)
                    def update():
                        try:
                            self._fetch(key, loader)
                        except Exception:
                            pass
                    threading.Thread(target=update, name="catalog-refresh", daemon=True).start()
                return self._view(key)
            if key in self.running:
                while key in self.running and not self.closed:
                    self.condition.wait(1)
                if self.closed:
                    raise ProviderError("SERVICE_STOPPING", "播放服务正在退出", 503)
                if key in self.values:
                    return self._view(key)
                raise ProviderError("CATALOG_UNAVAILABLE", "当前片单暂时不可用，请重试")
            self.running.add(key)
        try:
            self._fetch(key, loader)
        except Exception:
            with self.condition:
                if key in self.values:
                    return self._view(key)
            raise
        with self.condition:
            return self._view(key, cached=False)

    def close(self):
        with self.condition:
            self.closed = True
            self.condition.notify_all()


class Provider:
    def __init__(self, data_dir: Path, sdk=None, account=None):
        self.data_dir = Path(data_dir).resolve()
        self.source_dir = self.data_dir / "source-cache"
        self.source_dir.mkdir(parents=True, exist_ok=True)
        self.sdk, self.account = sdk, account
        self.source_downloader=SourceDownloader(lambda *args,**kwargs:self.sdk.http_request(*args,**kwargs))
        self.cache = RequestCache()
        self.seasons = SeasonResolver(self.sdk, self.detail, self._read)
        self.catalog_cache = CatalogCache(self.data_dir / "catalog-cache.json")
        self._source_guard = threading.Condition()
        self._sources_running = set()
        self._leases = {}
        self._write_lock = threading.Lock()
        self.qr_login = QrLoginManager(self.account, self._commit_qr_session,
            lambda: self.account._session_identity(self.account.load_session() or {}))
        self._last_progress = {}
        self._cooldown_until = 0.0
        self._closed = threading.Event()
        self._history_cursor_key = secrets.token_bytes(32)

    @classmethod
    def from_runtime(cls, data_dir, runtime_dir, signer_url):
        data_dir, runtime_dir = Path(data_dir).resolve(), Path(runtime_dir).resolve()
        data_dir.mkdir(parents=True, exist_ok=True)
        os.environ.update(HG_DATA_DIR=str(data_dir), HG_RUNTIME_DIR=str(runtime_dir),
                          HONGGUO_DATA_DIR=str(data_dir), HONGGUO_CONTENT_CONFIG=str(data_dir / "content-config.json"),
                          SIGN_SERVER=signer_url, IMPERSONATE="", DEVICE_POOL_SIZE="0")
        for name in ("REDIS_URL", "API_KEYS", "HONGGUO_PROXY", "HONGGUO_ACCOUNT_FILE", "HONGGUO_DEVICE_FILE",
                     "HONGGUO_MFA_FILE", "HONGGUO_ACCOUNT_LOG", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                     "http_proxy", "https_proxy", "all_proxy"):
            os.environ.pop(name, None)
        config = {"api_host": "api5-normal-sinfonlineb.fqnovel.com", "base_query": {
            "aid": "8662", "app_name": "novelread", "version_code": "73932", "version_name": "7.3.9.32",
            "channel": "vivo_8662_64", "device_platform": "android", "device_type": "PGT-AN10",
            "os_version": "12", "update_version_code": "73932"}, "session_headers": {
            "user-agent": "com.phoenix.read/73932 (Linux; U; Android 12; zh_CN_#Hans; PGT-AN10; Build/V417IR;tt-ok/3.12.13.20)",
            "x-tt-store-region": "cn", "x-tt-store-region-src": "did", "passport-sdk-version": "5051452"}}
        (data_dir / "content-config.json").write_text(json.dumps(config, ensure_ascii=False), encoding="utf-8")
        sdk = importlib.import_module("vendor.hongguo")
        account = importlib.import_module("vendor.desktop_account")
        account.load_device()
        sdk._hq_apply_device_identity()
        sdk.FEED_MAX_PAGES = 4
        # The category endpoint now returns an empty HTTP 200 when unsigned.
        # Verified with identical payloads: signed requests return real content.
        sdk.SIGN_LIST = True
        vault = SessionVault(data_dir / "account-session.dpapi")
        mfa_vault = SessionVault(data_dir / "account-mfa.dpapi")
        account.load_session, account.save_session = vault.load, vault.save
        account.save_mfa = lambda value: mfa_vault.save({**value, "at": value.get("at") or time.time()})
        def load_mfa():
            value = mfa_vault.load()
            return value if time.time() - number(value.get("at")) < 900 else {}
        account.load_mfa, account.clear_mfa = load_mfa, mfa_vault.clear
        def clear_session():
            mfa_vault.clear()
            return vault.clear()
        account.clear_session = clear_session
        return cls(data_dir, sdk, account)

    def _read(self, label, loader):
        if self._closed.is_set():
            raise ProviderError("SERVICE_STOPPING", "播放服务正在退出", 503)
        try:
            return loader()
        except ProviderError:
            raise
        except requests.Timeout:
            raise ProviderError("UPSTREAM_TIMEOUT", f"{label}连接超时，请稍后重试", 504) from None
        except Exception:
            raise ProviderError("UPSTREAM_UNAVAILABLE", f"暂时无法{label}，请稍后重试") from None

    @staticmethod
    def _genre(genre):
        if genre not in GENRES:
            raise ProviderError("INPUT_INVALID", "内容类型不正确", 400)
        return genre

    @staticmethod
    def _list(rows):
        result, seen = [], set()
        for row in rows or []:
            try:
                series = normalize_series(row)
            except (ProviderError, AttributeError):
                continue
            if series["id"] not in seen:
                seen.add(series["id"])
                result.append(series)
        return result

    def home(self, genre="short_play", cursor="", mode="discover", refresh=False):
        self._genre(genre)
        if mode not in {"discover", "recommend"}:
            raise ProviderError("INPUT_INVALID", "推荐页面不正确", 400)
        if mode == "discover" or genre != "short_play":
            page = self.catalog_cache.get("discover:" + genre,
                lambda: self._read("读取片单", lambda: self._list(self.sdk.browse(genre, sort="hot_score", max_items=30))),
                refresh=refresh)
            return {**page, "hasMore": False, "cursor": ""}
        session, offset = "", 0
        if cursor:
            try:
                if len(cursor) > 1024:
                    raise ValueError()
                state = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
                session, offset = str(state["session"]), int(state["offset"])
                if not 0 <= offset <= 10000 or len(session) > 512:
                    raise ValueError()
            except Exception:
                raise ProviderError("INPUT_INVALID", "推荐游标已失效，请刷新", 400) from None
        if refresh and not cursor:
            self.cache.invalidate(("home", mode, cursor))
        response = self.cache.get(("home", mode, cursor), 30,
            lambda: self._read("读取推荐", lambda: self.sdk.feed(session=session, offset=offset, limit=18)))
        items = self._list(response.get("items"))
        next_offset = number(response.get("offset"))
        next_cursor = base64.urlsafe_b64encode(json.dumps({"session": response.get("session") or session,
                    "offset": next_offset}, separators=(",", ":")).encode()).decode().rstrip("=")
        return {"items": items, "hasMore": bool(items) and next_offset > offset,
                "cursor": next_cursor if next_offset > offset else ""}

    def search(self, query):
        query = str(query or "").strip()
        if not 1 <= len(query) <= 80 or any(ord(char) < 32 for char in query):
            raise ProviderError("INPUT_INVALID", "请输入 1–80 个字的剧名", 400)
        def fetch(term):
            def read():
                rows = self._read("搜索短剧", lambda: self.sdk.search(term, max_items=40))
                return SearchRows(self._list(rows), complete=getattr(rows, 'complete', True))
            return self.cache.get(("search", term), 120,
                read, cacheable=lambda rows: rows.complete)
        return search_series(query, fetch)

    def rank(self, board="hot", genre="short_play"):
        self._genre(genre)
        if board not in {"hot", "new", "recommend"}:
            raise ProviderError("INPUT_INVALID", "榜单不正确", 400)
        def read():
            rows = self.sdk.rank(board, limit=50) if genre == "comic_series" else self.sdk.browse(
                    genre, sort="online_time" if board == "new" else "hot_score", max_items=50)
            return self._list(rows)
        return {"items": self.cache.get(("rank", board, genre), 120, lambda: self._read("读取排行榜", read))}

    def filters(self, genre="short_play"):
        self._genre(genre)
        rows = self.cache.get(("filters", genre), 600, lambda: self._read("读取筛选条件", lambda: self.sdk.filters(genre)))
        groups = []
        labels = {"category_dim_theme": "题材", "category_dim_role": "设定", "category_dim_epoch": "背景"}
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict) or row.get("type") not in labels:
                continue
            options, seen = [], set()
            for option in (row.get("items") or [])[:160]:
                if not isinstance(option, dict):
                    continue
                name, value = str(option.get("name") or "").strip()[:80], str(option.get("id") or "")
                if name and name not in {"全部", "不限"} and re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value) and value not in seen:
                    options.append({"id": value, "name": name})
                    seen.add(value)
            if options:
                groups.append({"type": row["type"], "name": labels[row["type"]], "items": options})
        themes = next((group["items"] for group in groups if group["type"] == "category_dim_theme"), [])
        return {"items": [], "filters": {"themes": [item["name"] for item in themes],
                                            "themeOptions": themes, "groups": groups}}

    def browse(self, genre="short_play", sort="hot_score", theme="", setting="", background="", cursor=""):
        self._genre(genre)
        if sort not in SORTS or any(not isinstance(value, str) or len(value) > 80 for value in (theme, setting, background, cursor)):
            raise ProviderError("INPUT_INVALID", "筛选条件不正确", 400)
        filters = self.filters(genre)["filters"]
        selected = {"category_dim_theme": theme, "category_dim_role": setting, "category_dim_epoch": background}
        for kind, value in selected.items():
            if value and not any(group["type"] == kind and any(item["id"] == value for item in group["items"]) for group in filters["groups"]):
                raise ProviderError("INPUT_INVALID", "这项分类已更新，请重新选择题材", 400)
        scope = (genre, sort, theme, setting, background)

        def read():
            offset, shown = 0, []
            if cursor:
                continuation = self.cache.get(("browse-cursor", cursor), 900, lambda: None)
                if not continuation or continuation["scope"] != scope:
                    raise ProviderError("CURSOR_EXPIRED", "片单已更新，请刷新后继续浏览", 400)
                offset, shown = continuation["offset"], continuation["shown"]
            page_reader = getattr(self.sdk, "browse_page", None)
            if page_reader:
                data = self._read("读取片单", lambda: page_reader(genre, sort=sort, theme=theme or None,
                    setting=setting or None, background=background or None, offset=offset, shown=shown))
                items, has_more = self._list(data.get("items") or []), bool(data.get("hasMore"))
            else:
                items = self._read("读取片单", lambda: self._list(self.sdk.browse(genre, sort=sort,
                    theme=theme or None, setting=setting or None, background=background or None, max_items=50)))
                data, has_more = {}, False
            next_cursor = ""
            if has_more and items:
                next_cursor = secrets.token_hex(12)
                self.cache.get(("browse-cursor", next_cursor), 900, lambda: {"scope": scope,
                    "offset": data["offset"], "shown": data["shown"]})
            return {"items": items, "filters": filters, "hasMore": has_more and bool(items), "cursor": next_cursor}

        return self.cache.get(("browse", *scope, cursor), 120, read)

    def detail(self, series_id):
        sid = identifier(series_id)
        def read():
            meta, rows = self.sdk.get_episodes(sid)
            episodes = [{"index": number(row.get("index")), "vid": identifier(row.get("vid")),
                         "title": str(row.get("title") or f"第 {number(row.get('index'))} 集")[:100],
                         "duration": number(row.get("duration"))} for row in rows if number(row.get("index"))]
            if not episodes:
                raise ProviderError("SERIES_NOT_FOUND", "这部剧暂时没有可播放的剧集", 404)
            return {"series": normalize_series({**meta, "id": sid}), "episodes": episodes}
        return self.cache.get(("detail", sid), 600, lambda: self._read("读取剧集", read))

    def next_season(self, series_id, refresh=False):
        return self.seasons.resolve(identifier(series_id), refresh=refresh)

    def season_overview(self, series_id, refresh=False):
        return self.seasons.overview(identifier(series_id), refresh=refresh)

    def comments(self, series_id, episode, cursor=0):
        sid = identifier(series_id)
        if not 1 <= number(episode) <= 100000 or not 0 <= number(cursor) <= 1000000:
            raise ProviderError("INPUT_INVALID", "评论页码不正确", 400)
        target = next((row for row in self.detail(sid)["episodes"] if row["index"] == int(episode)), None)
        if not target:
            raise ProviderError("EPISODE_NOT_FOUND", "这集不存在", 404)
        def read():
            body = {"comment_source": 4, "server_channel": 18, "group_type": 30, "comment_type": 4,
                "sort": 1, "count": 20, "cursor": str(cursor), "business_param": {
                    "book_id": sid, "item_id": target["vid"], "need_count": True, "req_type": 0}}
            url = self.sdk.build_url(f"/novel/commentapi/comment/list/{target['vid']}/v1/")
            headers = dict(self.sdk.CFG["session_headers"])
            payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
            headers.update({"content-type": "application/json; charset=utf-8",
                            "x-ss-stub": hashlib.md5(payload).hexdigest().upper()})
            headers.update(self.sdk.sign(url, headers))
            self.sdk.SG.throttle.wait()
            response = self.sdk.http_request("POST", url, data=payload, headers=headers, timeout=20)
            response.raise_for_status()
            data = response.json()
            if data.get("code") not in (0, "0"):
                raise ProviderError("COMMENTS_UNAVAILABLE", "评论暂时无法加载，请稍后重试")
            data = data.get("data") or {}
            info = data.get("common_list_info") or {}
            items = []
            for item in data.get("data_list") or []:
                comment = item.get("comment") or {}
                common = comment.get("common") or {}
                user = (common.get("user_info") or {}).get("base_info") or {}
                stamp = number(common.get("create_timestamp"))
                items.append({"id": str(comment.get("comment_id") or ""),
                    "text": str((common.get("content") or {}).get("text") or ""),
                    "nickname": str(user.get("user_name") or "匿名"), "avatar": str(user.get("user_avatar") or ""),
                    "likes": number((comment.get("stat") or {}).get("digg_count")),
                    "time": datetime.fromtimestamp(stamp, timezone.utc).isoformat() if stamp else ""})
            return {"items": items, "total": number(info.get("total")), "cursor": number(info.get("cursor")),
                    "hasMore": bool(info.get("has_more"))}
        return self.cache.get(("comments", sid, int(episode), int(cursor)), 30, lambda: self._read("读取评论", read))

    def danmaku(self, series_id, episode, position=0, duration=0, refresh=False):
        sid = identifier(series_id)
        if isinstance(episode, bool) or not isinstance(episode, int) or not 1 <= episode <= 100000:
            raise ProviderError("INPUT_INVALID", "弹幕集数不正确", 400)
        try:
            danmaku_contract.milliseconds(position)
            danmaku_contract.milliseconds(duration)
        except ValueError:
            raise ProviderError("INPUT_INVALID", "弹幕播放位置不正确", 400) from None
        detail = self.detail(sid)
        target = next((row for row in detail["episodes"] if row["index"] == episode), None)
        if not target:
            raise ProviderError("EPISODE_NOT_FOUND", "这集不存在", 404)
        full_duration = duration or target.get("duration") or 0
        credentials = dict(self.account.load_session() or {})
        identity = self.account._session_identity(credentials)
        key = ("danmaku", identity, sid, episode, int(position // 30), full_duration)
        def read():
            request = danmaku_contract.list_request(sid, target["vid"], position, full_duration)
            response = self.account._json(self.account._call("POST",
                f"/novel/commentapi/comment/list/{target['vid']}/v1/", body=request, session=credentials))
            if self.account._account_changed(credentials):
                raise ProviderError("ACCOUNT_CHANGED", "账号已切换，请重试读取弹幕", 409)
            try:
                return danmaku_contract.page(response, sid, target["vid"], position, full_duration)
            except ValueError:
                raise ProviderError("DANMAKU_UNAVAILABLE", "手机弹幕暂时无法加载，请稍后重试") from None
        if refresh: self.cache.invalidate(key)
        return self.cache.get(key, 60, lambda: self._read("读取手机弹幕", read))

    def session(self):
        value = self.account.public_session()
        return {"loggedIn": bool(value.get("loggedIn")), "uid": str(value.get("uid") or ""),
                "nickname": str(value.get("userName") or ""), "avatar": "", "mobile": str(value.get("mobile") or "")}

    def _commit_qr_session(self, candidate, origin_identity):
        with self._write_lock:
            if origin_identity != self.account._session_identity(self.account.load_session() or {}):
                raise ProviderError("ACCOUNT_CHANGED", "账号已切换，已取消之前的扫码登录", 409)
            if not candidate.get("uid") or not (candidate.get("cookie") or candidate.get("token")):
                raise QrLoginError("QR_MOBILE_SESSION_UNAVAILABLE", "扫码账号暂时无法连接手机数据，请重试")
            self.account.save_session(candidate)
            self.account.clear_mfa()
            self.cache.clear()
            self.seasons.clear()
            self._last_progress.clear()
            return self.session()

    def _require_login(self):
        session = self.session()
        if not session["loggedIn"]:
            raise ProviderError("LOGIN_REQUIRED", "请先登录红果账号", 401)
        return session

    def _expect_uid(self, expected_uid):
        session = self._require_login()
        if not isinstance(expected_uid, str) or not expected_uid or session["uid"] != expected_uid:
            raise ProviderError("ACCOUNT_CHANGED", "账号已切换，已取消旧账号的操作", 409)
        return session

    def import_session(self, payload):
        """Private migration boundary, called by Electron main; no cloud writes."""
        if not isinstance(payload, dict):
            raise ProviderError("INPUT_INVALID", "登录态格式不正确", 400)
        allowed = {"uid": 512, "token": 8192, "cookie": 16384, "user_name": 200,
                   "mobile": 20, "avatar": 2000, "saved_at": 32}
        session = {}
        for key, limit in allowed.items():
            value = payload.get(key)
            if value is None:
                continue
            if not isinstance(value, (str, int, float)) or len(str(value)) > limit or any(ord(char) < 32 for char in str(value)):
                raise ProviderError("INPUT_INVALID", "登录态格式不正确", 400)
            session[key] = value
        uid = session.get("uid")
        if (not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9#_+./=-]{1,512}", uid)
                or not any(isinstance(session.get(key), str) and session[key].strip() for key in ("token", "cookie"))):
            raise ProviderError("INPUT_INVALID", "旧版本没有可迁移的有效登录态", 400)
        with self._write_lock:
            current = self.account.load_session() or {}
            if (isinstance(current.get("uid"), str) and current["uid"]
                    and any(isinstance(current.get(key), str) and current[key].strip() for key in ("token", "cookie"))):
                if current["uid"] != uid:
                    raise ProviderError("ACCOUNT_CHANGED", "新客户端已有登录账号，未覆盖现有登录态", 409)
                # A repeated migration cannot replace an existing valid session.
                return self.session()
            self.account.save_session(session)
            self.cache.clear()
            self._last_progress.clear()
        return self.session()

    def send_code(self, mobile):
        if not re.fullmatch(r"1[3-9][0-9]{9}", str(mobile)):
            raise ProviderError("INPUT_INVALID", "手机号格式不正确", 400)
        result = self._read("发送验证码", lambda: self.account.send_code(mobile))
        if not result.get("ok"):
            raise ProviderError("SMS_SEND_FAILED", "验证码暂时无法发送，请稍后重试", 400)
        return {"sent": True, "retryAfter": number(result.get("retryTime"), 60)}

    def _mfa_public(self, context):
        directions = []
        for way in context.get("verifyWays") or []:
            if not isinstance(way, dict) or way.get("way") != "mobile_up_sms_verify":
                continue
            recipient, text = str(way.get("channelMobile") or ""), str(way.get("smsContent") or "")
            if re.fullmatch(r"\+?[0-9]{3,24}", recipient) and 1 <= len(text) <= 256 and not any(ord(char) < 32 for char in text):
                directions.append({"recipient": recipient, "text": text})
        return {"mfaRequired": True, "challengeId": str(context.get("_challenge_id") or ""),
                "mobile": self.account.mask_mobile(context.get("_login_mobile", "")),
                "requiresManualSms": True, "directions": directions,
                "message": "使用登录手机号的系统短信应用发送以下文字，然后在电脑完成验证。无需安装红果手机应用。"}

    def _mfa_context_for(self, mobile, challenge_id=""):
        context = self.account.load_mfa() or {}
        if not context or not context.get("_challenge_id") or time.time() - number(context.get("at")) >= 900:
            raise ProviderError("MFA_EXPIRED", "安全验证已过期，请返回重新登录", 409)
        if (context.get("_login_mobile") != mobile or
                (challenge_id and context.get("_challenge_id") != challenge_id) or
                context.get("_origin_identity") != self.account._session_identity(self.account.load_session() or {})):
            raise ProviderError("ACCOUNT_CHANGED", "登录账号或验证步骤已改变，请重新登录", 409)
        return context

    def mfa_send(self, mobile, code="", challenge_id=""):
        """Expose the carrier SMS instruction on an explicit click; never fake SIM sending."""
        if not re.fullmatch(r"1[3-9][0-9]{9}", str(mobile)):
            raise ProviderError("INPUT_INVALID", "手机号格式不正确", 400)
        with self._write_lock:
            context = self._mfa_context_for(mobile, challenge_id)
            challenge = self._mfa_public(context)
            if not challenge["directions"]:
                raise ProviderError("MFA_UNSUPPORTED", "服务端未提供可用的短信安全验证指引，请返回重新登录", 409)
            return {"sent": False, "retryAfter": 0, **challenge}

    def mfa_verify(self, mobile, code, challenge_id=""):
        if not re.fullmatch(r"1[3-9][0-9]{9}", str(mobile)) or not re.fullmatch(r"[0-9]{4,8}", str(code)):
            raise ProviderError("INPUT_INVALID", "手机号或原短信验证码格式不正确", 400)
        with self._write_lock:
            context = self._mfa_context_for(mobile, challenge_id)
            result = self._read("完成短信安全验证", lambda: self.account.verify_mfa(mobile, code))
            if result.get("ok"):
                self.cache.clear()
                self._last_progress.clear()
                return self.session()
            if context.get("_origin_identity") != self.account._session_identity(self.account.load_session() or {}):
                raise ProviderError("ACCOUNT_CHANGED", "登录账号已改变，请重新登录", 409)
            if result.get("pending"):
                current = self.account.load_mfa() or context
                current.update(_login_mobile=mobile, _origin_identity=context["_origin_identity"],
                               _challenge_id=context["_challenge_id"])
                self.account.save_mfa(current)
                return {**self._mfa_public(current), "pending": True,
                        "message": "尚未确认收到验证短信，请确认已发送并稍后再试"}
            raise ProviderError("MFA_FAILED", "安全验证未通过，请检查原验证码或返回重新登录", 400)

    def login(self, mobile, code):
        if not re.fullmatch(r"1[3-9][0-9]{9}", str(mobile)) or not re.fullmatch(r"[0-9]{4,8}", str(code)):
            raise ProviderError("INPUT_INVALID", "手机号或验证码格式不正确", 400)
        with self._write_lock:
            origin_identity = self.account._session_identity(self.account.load_session() or {})
            result = self._read("登录账号", lambda: self.account.sms_login(mobile, code))
            if result.get("mfaRequired"):
                if origin_identity != self.account._session_identity(self.account.load_session() or {}):
                    raise ProviderError("ACCOUNT_CHANGED", "登录账号已改变，请重新登录", 409)
                context = self.account.load_mfa() or result.get("mfa") or {}
                context.update(_login_mobile=mobile, _origin_identity=origin_identity, _challenge_id=secrets.token_hex(16))
                self.account.save_mfa(context)
                return self._mfa_public(context)
            if not result.get("ok"):
                raise ProviderError("LOGIN_FAILED", "登录未成功，请检查验证码是否正确或已过期", 400)
            self.cache.clear()
            self._last_progress.clear()
        return self.session()

    def logout(self):
        with self._write_lock:
            self.account.clear_session()
            self.cache.clear()
            self._last_progress.clear()
        return self.session()

    def _history_cursor(self, state):
        encoded = base64.urlsafe_b64encode(json.dumps(state, separators=(",", ":")).encode()).decode().rstrip("=")
        digest = hmac.new(self._history_cursor_key, encoded.encode(), hashlib.sha256).hexdigest()
        return encoded + "." + digest

    def _history_state(self, cursor, uid, identity):
        initial = {"v": 1, "uid": uid, "identity": identity, "offset": 0, "previous": "", "page": 0}
        if not cursor:
            return initial
        try:
            if not isinstance(cursor, str) or len(cursor) > 2048:
                raise ValueError()
            encoded, digest = cursor.rsplit(".", 1)
            expected = hmac.new(self._history_cursor_key, encoded.encode(), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(digest, expected):
                raise ValueError()
            state = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
            if (state.get("v") != 1 or not isinstance(state.get("offset"), int)
                    or not 0 <= state["offset"] <= 1000000 or not isinstance(state.get("page"), int)
                    or not 0 <= state["page"] <= 100 or not re.fullmatch("[a-f0-9]{64}", state.get("previous", ""))):
                raise ValueError()
            if state.get("uid") != uid or state.get("identity") != identity:
                raise ProviderError("ACCOUNT_CHANGED", "账号已切换，请重新同步历史", 409)
            return state
        except ProviderError:
            raise
        except (ValueError, TypeError, AttributeError, KeyError):
            raise ProviderError("HISTORY_CURSOR_INVALID", "历史同步位置已失效，请重新同步", 400) from None

    def history(self, cursor="", limit=100, refresh=False):
        """Read one real server page, retaining every returned row and original times."""
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 500:
            raise ProviderError("INPUT_INVALID", "历史页大小不正确", 400)
        session = self._require_login()
        credentials = dict(self.account.load_session() or {})
        identity = self.account._session_identity(credentials)
        state = self._history_state(cursor, session["uid"], identity)
        key = ("history-page", session["uid"], identity, state["offset"], limit)
        if refresh:
            self.cache.invalidate(key)
        def read():
            response = self.account.remote_history_page(offset=state["offset"], limit=limit, session=credentials)
            if (response.get("accountChanged") or self.account._account_changed(credentials)
                    or self.session()["uid"] != session["uid"]):
                raise ProviderError("ACCOUNT_CHANGED", "账号已切换，请重新同步", 409)
            if not response.get("ok"):
                raise ProviderError("HISTORY_UNAVAILABLE", "云端历史暂时无法读取，请稍后继续同步")
            return response
        try:
            response = self.cache.get(key, 15, lambda: self._read("读取历史", read))
        except ProviderError as error:
            if not cursor or error.code == "ACCOUNT_CHANGED":
                raise
            return {"items": [], "total": 0, "hasMore": True, "nextCursor": cursor,
                    "complete": False, "warning": "这页历史暂时未同步，已保留现有记录，可稍后继续"}
        if self.account._account_changed(credentials) or self.session()["uid"] != session["uid"]:
            raise ProviderError("ACCOUNT_CHANGED", "账号已切换，请重新同步", 409)
        raw = response.get("items") or []
        if not isinstance(raw, list):
            raise ProviderError("HISTORY_UNAVAILABLE", "云端历史格式暂时不可用")
        fingerprint = str(response.get("fingerprint") or hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest())
        if state["previous"] and fingerprint == state["previous"]:
            return {"items": [], "total": number(response.get("total")), "hasMore": False,
                    "nextCursor": None, "complete": False,
                    "warning": "服务端重复返回上一页，已保留当前历史，请稍后重新同步"}
        items = {}
        for row in raw:
            if not isinstance(row, dict):
                continue
            sid = row.get("book_id_str") or row.get("book_id") or row.get("seriesId")
            try:
                series = normalize_series({**row, "id": sid, "episodeCount": row.get("episode_cnt") or row.get("total")})
            except (ProviderError, TypeError, ValueError):
                continue
            try:
                stamp = max(0, float(row.get("read_timestamp_ms") if "read_timestamp_ms" in row else row.get("updatedAt") or 0))
                if not math.isfinite(stamp):
                    stamp = 0
                if "read_timestamp_ms" in row or stamp > 1e12:
                    stamp /= 1000
            except (TypeError, ValueError, OverflowError):
                stamp = 0
            item = {"series": series,
                    "episode": number(row.get("vid_index") or row.get("chapter_index") or row.get("episode"), 1),
                    "position": mobile_position_seconds(row.get("current_play_position") or row.get("position") or 0),
                    # Mobile `duration` may describe the entire series, not this episode.
                    "duration": 0, "watchedAt": stamp, "uid": session["uid"]}
            previous = items.get(series["id"])
            if previous is None or item["watchedAt"] > previous["watchedAt"]:
                items[series["id"]] = item
        has_more = bool(raw) and bool(response.get("hasMore"))
        warning = ""
        if has_more and state["page"] >= 100:
            has_more = False
            warning = "本轮历史同步请求较多，已保留所有已收到记录，可稍后重新同步"
        next_cursor = self._history_cursor({**state, "offset": number(response.get("nextOffset"), state["offset"] + len(raw)),
                    "previous": fingerprint, "page": state["page"] + 1}) if has_more else None
        return {"items": sorted(items.values(), key=lambda item: item["watchedAt"], reverse=True),
                "total": number(response.get("total")), "hasMore": has_more, "nextCursor": next_cursor,
                "complete": not has_more and not warning, **({"warning": warning} if warning else {})}

    def favorites(self):
        session = self._require_login()
        def read():
            response = self.account.remote_favorites()
            if not response.get("ok"):
                raise ProviderError("FAVORITES_UNAVAILABLE", "云端收藏暂时无法读取，请稍后重试")
            if self.session()["uid"] != session["uid"]:
                raise ProviderError("ACCOUNT_CHANGED", "账号已切换，请重新同步", 409)
            return self._list(response.get("items"))
        return {"items": self.cache.get(("favorites", session["uid"]), 15, lambda: self._read("读取收藏", read))}

    def _remote_playback_progress(self, sid, session):
        """Read fresh resume data for one series; this POST is a read-only RPC."""
        response = self.account._json(self.account._call(
            "POST", "/reading/bookapi/read_progress/get/v", body={"book_ids": {"2": [int(sid)]}}, session=session))
        if not isinstance(response, dict) or response.get("code") not in (0, "0"):
            raise ProviderError("CLOUD_READ_FAILED", "暂时读不到云端续播进度，已保留待同步记录")
        rows = response.get("video_data")
        if not isinstance(rows, list):
            raise ProviderError("CLOUD_READ_FAILED", "云端续播进度格式暂时不可用，已保留待同步记录")
        matches = []
        for row in rows:
            if not isinstance(row, dict) or str(row.get("series_id") or "") != sid:
                continue
            stamp, position, episode = row.get("last_watch_time"), row.get("current_play_time"), row.get("vid_index")
            if (any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                    or value < 0 for value in (stamp, position, episode))
                    or not 1 <= episode <= 100000 or int(episode) != episode or position > 86400000
                    or not re.fullmatch(r"[0-9]{8,24}", str(row.get("vid") or ""))):
                raise ProviderError("CLOUD_READ_FAILED", "云端续播进度格式暂时不可用，已保留待同步记录")
            matches.append({"episode": int(episode), "vid": str(row["vid"]), "position": position,
                            "updatedAt": stamp})
        if rows and not matches:
            raise ProviderError("CLOUD_READ_FAILED", "云端未返回目标剧的续播进度，已保留待同步记录")
        return max(matches, key=lambda row: row["updatedAt"], default={"episode": 0, "vid": "", "position": 0, "updatedAt": 0})

    @staticmethod
    def _replay_superseded(cloud, item, stamp_ms):
        # Millisecond rounding of the same partially completed action must not
        # prevent repairing its second store. Episode size is not recency.
        delta = stamp_ms - item["read_timestamp_ms"]
        if delta > 1:
            return True
        if delta < -1:
            return False
        episode = number(cloud.get("episode"))
        if episode and episode != item["vid_index"]:
            return True
        vid = cloud.get("vid")
        if vid and str(vid) != str(item["vid"]):
            return True
        position = cloud.get("position") or 0
        if isinstance(position, bool) or not isinstance(position, (int, float)) or not math.isfinite(position) or position < 0:
            raise ProviderError("CLOUD_READ_FAILED", "云端进度格式暂时不可用，已保留待同步记录")
        return episode == item["vid_index"] and position > item["current_play_position"] + 1

    def progress(self, payload):
        """Only a direct playback action may write cloud progress. No guard or bulk push."""
        if not isinstance(payload, dict) or not isinstance(payload.get("series"), dict):
            raise ProviderError("INPUT_INVALID", "播放进度格式不正确", 400)
        for key in ("episode", "position", "duration", "watchedAt"):
            value = payload.get(key)
            if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                                      or not math.isfinite(value) or value < 0):
                raise ProviderError("INPUT_INVALID", "播放进度格式不正确", 400)
        expected = self._expect_uid(payload.get("expectedUid"))
        series = payload.get("series") or {}
        sid = identifier(series.get("id"))
        episode = number(payload.get("episode"))
        position, duration = float(payload.get("position") or 0), float(payload.get("duration") or 0)
        intent = payload.get("intent", "active")
        watched_at = epoch_seconds(payload.get("watchedAt"))
        if not 1 <= episode <= 100000 or intent not in {"active", "replay", "backfill"} or watched_at > time.time() + 60:
            raise ProviderError("INPUT_INVALID", "播放进度格式不正确", 400)
        if position > 86400 or duration > 86400:
            raise ProviderError("INPUT_INVALID", "播放进度超出有效范围", 400)
        if intent == "backfill":
            return {"synced": False, "skipped": True, "reason": "历史同步只读取云端，不自动改写云端进度"}
        with self._write_lock:
            self._expect_uid(expected["uid"])
            session = dict(self.account.load_session() or {})
            uid = self.account._session_identity(session)
            previous = self._last_progress.get((uid, sid))
            if previous and previous[0] == (episode, position) and time.monotonic() - previous[1] < 15:
                return {"synced": True, "skipped": True}
            if time.monotonic() < self._cooldown_until:
                raise ProviderError("SYNC_COOLDOWN", "云端同步正在冷却，请稍后重试", 429)
            if self.account._account_changed(session):
                raise ProviderError("ACCOUNT_CHANGED", "账号已切换，已取消旧账号的同步", 409)
            detail = self.detail(sid)
            target = next((row for row in detail["episodes"] if row["index"] == episode), None)
            if not target:
                raise ProviderError("EPISODE_NOT_FOUND", "这集不存在", 404)
            item = build_progress_item(series, episode, target["vid"], position, duration, watched_at,
                                       detail["series"].get("totalEpisodes") or len(detail["episodes"]))
            if intent == "replay":
                if not payload.get("watchedAt"):
                    raise ProviderError("INPUT_INVALID", "旧进度缺少观看时间，已取消重试", 400)
                # One fresh snapshot serves all retries in this short batch.
                self.cache.get(("replay-cloud", expected["uid"]), 5,
                               lambda: self._read("核对云端进度", lambda: self.account._history_all_cached(force=True)))
                cloud = self._read("核对云端进度", lambda: self.account.remote_progress(sid))
                if not isinstance(cloud, dict) or not cloud.get("ok"):
                    raise ProviderError("CLOUD_READ_FAILED", "暂时读不到云端进度，已跳过旧进度重试")
                self._expect_uid(expected["uid"])
                if self.account._account_changed(session):
                    raise ProviderError("ACCOUNT_CHANGED", "账号已切换，已取消旧账号的同步", 409)
                try:
                    cloud_stamp_ms = round(epoch_seconds(cloud.get("updatedAt") or 0) * 1000)
                except ValueError:
                    raise ProviderError("CLOUD_READ_FAILED", "云端进度时间暂时不可用，已保留待同步记录") from None
                if self._replay_superseded(cloud, item, cloud_stamp_ms):
                    return {"synced": True, "skipped": True, "reason": "云端进度已更新，已忽略旧进度重试"}
                playback = self._read("核对云端续播进度", lambda: self._remote_playback_progress(sid, session))
                self._expect_uid(expected["uid"])
                if self.account._account_changed(session):
                    raise ProviderError("ACCOUNT_CHANGED", "账号已切换，已取消旧账号的同步", 409)
                if self._replay_superseded(playback, item, playback["updatedAt"]):
                    return {"synced": True, "skipped": True, "reason": "云端续播进度已更新，已忽略旧进度重试"}

            def write(label, endpoint, body):
                self._expect_uid(expected["uid"])
                if self.account._account_changed(session):
                    raise ProviderError("ACCOUNT_CHANGED", "账号已切换，已取消旧账号的同步", 409)
                result = self._read(label, lambda: self.account._json(self.account._call(
                    "POST", endpoint, body=body, session=session)))
                if not isinstance(result, dict) or result.get("code") not in (0, "0"):
                    if isinstance(result, dict) and result.get("code") in (100, "100"):
                        self._cooldown_until = time.monotonic() + 90
                        raise ProviderError("SYNC_COOLDOWN", "云端同步正在冷却，请稍后重试", 429)
                    raise ProviderError("SYNC_FAILED", "播放进度尚未完全同步，已保留待同步记录")
                data = result.get("data")
                if isinstance(data, dict) and data.get("update_fail_datas"):
                    raise ProviderError("SYNC_FAILED", "这次播放进度没有保存成功，已保留待同步记录")

            write("同步观看历史", "/reading/bookapi/read_history/update/v", {"update_datas": [item]})
            write("同步续播进度", "/reading/bookapi/read_progress/upload/v",
                  {"books": [build_playback_progress_item(item)], "write_mode": 1})
            self._expect_uid(expected["uid"])
            if self.account._account_changed(session):
                raise ProviderError("ACCOUNT_CHANGED", "账号已切换，已取消旧账号的同步", 409)
            self._last_progress[(uid, sid)] = ((episode, position), time.monotonic())
            self.cache.clear()
            return {"synced": True, "episode": episode}

    def favorite(self, series_id, favorite, expected_uid=None):
        self._expect_uid(expected_uid)
        sid = identifier(series_id)
        with self._write_lock:
            self._expect_uid(expected_uid)
            def read():
                self._expect_uid(expected_uid)
                result = self.account.remote_favorites()
                self._expect_uid(expected_uid)
                return result
            def write(sid, value):
                self._expect_uid(expected_uid)
                result = self.account.set_favorite(sid, value)
                self._expect_uid(expected_uid)
                return result
            def reconcile():
                try:
                    return reconcile_favorite(sid, bool(favorite), read, write)
                except ValueError as error:
                    raise ProviderError("FAVORITE_FAILED", str(error)) from None
            result = self._read("同步收藏", reconcile)
            self.cache.clear()
        return {"synced": True, "favorite": bool(favorite)}

    def _cancel(self, cancelled):
        if self._closed.is_set() or (cancelled and cancelled()):
            raise ProviderError("MEDIA_CANCELLED", "播放准备已取消", 409)

    @staticmethod
    def _media_url(value):
        if not isinstance(value, str):
            return None
        if not value.startswith("https://"):
            try:
                value = base64.b64decode(value).decode()
            except Exception:
                return None
        parsed = urlsplit(value)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            return None
        try:
            if not ipaddress.ip_address(parsed.hostname).is_global:
                return None
        except ValueError:
            pass
        if parsed.hostname in {"localhost", "localhost.localdomain"}:
            return None
        return value

    def _compatible_tracks(self, vid, tracks, cancelled):
        def compatible(rows):
            return [track for track in rows if isinstance(track, dict)
                    and str((track.get("video_meta") or {}).get("codec_type") or "hevc").lower() in CODECS]

        supported = compatible(tracks)
        if supported:
            return supported
        endpoint = None
        for track in tracks:
            value = track.get("_hq_fallback_api") if isinstance(track, dict) else None
            if isinstance(value, dict):
                value = value.get("fallback_api")
            try:
                value = self._media_url(value)
                parsed = urlsplit(value) if value else None
            except ValueError:
                continue
            if parsed and (parsed.hostname == "snssdk.com" or parsed.hostname.endswith(".snssdk.com")
                           or parsed.hostname == "bytedance.com" or parsed.hostname.endswith(".bytedance.com")):
                # The model pins ByteVC2 file IDs. Request the official HEVC
                # rendition while retaining its authorization and other flags.
                query = [(key, val) for key, val in parse_qsl(parsed.query, keep_blank_values=True)
                         if key not in {"force_fids", "codec_type"}]
                query.append(("codec_type", "1"))
                endpoint = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))
                break
        if not endpoint:
            return []

        def read():
            self._cancel(cancelled)
            with self.sdk.http_request("GET", endpoint, timeout=(10, 15), allow_redirects=False,
                                       headers={"Accept": "application/json"}) as response:
                response.raise_for_status()
                if response.status_code != 200 or len(response.content) > 1024 * 1024:
                    raise ValueError("Invalid compatible playback response")
                payload = response.json()
            self._cancel(cancelled)
            if not isinstance(payload, dict) or payload.get("code") != 0:
                raise ValueError("Invalid compatible playback model")
            info = payload.get("video_info")
            if not isinstance(info, dict) or info.get("code") != 0 or not isinstance(info.get("data"), dict):
                raise ValueError("Invalid compatible playback model")
            model = info["data"]
            rows = model.get("video_list")
            if isinstance(rows, dict):
                rows = list(rows.values())
            if not isinstance(rows, list) or len(rows) > 32:
                raise ValueError("Invalid compatible playback tracks")
            normalized = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                meta = row.get("video_meta")
                encryption = row.get("encrypt_info")
                if meta is not None and not isinstance(meta, dict) or encryption is not None and not isinstance(encryption, dict):
                    continue
                track = {**row, "video_meta": {**{key: row[key] for key in ("definition", "codec_type", "size") if key in row}, **(meta or {})},
                         "encrypt_info": {**{key: row[key] for key in ("encrypt", "spade_a") if key in row}, **(encryption or {})}}
                for field in ("main_url", "backup_url_1", "backup_url"):
                    value = row.get(field)
                    try:
                        track[field] = self._media_url(value)
                        if not track[field] and model.get("key_seed") and value:
                            track[field] = self._media_url(decode_playback_url(value, model["key_seed"]))
                    except ValueError:
                        track[field] = None
                if any(track[field] for field in ("main_url", "backup_url_1", "backup_url")):
                    normalized.append(track)
            supported = compatible(normalized)
            if not supported:
                raise ProviderError("MEDIA_CODEC_UNSUPPORTED", "上游暂时没有兼容的播放画质，请稍后重试")
            return supported

        return self.cache.get(("compatible-tracks", vid), 600, lambda: self._read("取得兼容播放地址", read))

    def source(self, series_id, episode, quality="auto", cancelled=None) -> Path:
        sid = identifier(series_id)
        if quality not in QUALITIES:
            raise ProviderError("INPUT_INVALID", "清晰度不正确", 400)
        target = next((row for row in self.detail(sid)["episodes"] if row["index"] == int(episode)), None)
        if not target:
            raise ProviderError("EPISODE_NOT_FOUND", "这集不存在", 404)
        key = f"{target['vid']}_{quality}"
        out = self.source_dir / f"{key}.mp4"
        with self._source_guard:
            while key in self._sources_running:
                self._cancel(cancelled)
                self._source_guard.wait(timeout=.2)
            self._cancel(cancelled)
            if out.is_file() and out.stat().st_size:
                out.touch()
                self._leases[str(out)] = self._leases.get(str(out), 0) + 1
                return out
            self._sources_running.add(key)
        encrypted, raw, partial = (self.source_dir / f"{key}.{suffix}" for suffix in ("encrypted.partial", "raw.partial", "ready.partial"))
        try:
            tracks = self._read("取得播放地址", lambda: self.sdk.get_video_tracks([target["vid"]]).get(target["vid"]) or [])
            tracks = self._compatible_tracks(target["vid"], tracks, cancelled)
            if not tracks:
                raise ProviderError("MEDIA_CODEC_UNSUPPORTED", "上游暂时没有兼容的播放画质，请稍后重试")
            def resolution(track):
                return number(re.sub(r"\D", "", str((track.get("video_meta") or {}).get("definition") or "")))
            desired = number(re.sub(r"\D", "", quality), 1080)
            exact = [track for track in tracks if resolution(track) == desired]
            lower = [track for track in tracks if resolution(track) <= desired]
            track = max(exact or lower or tracks, key=resolution)
            urls = [self._media_url(track.get(field)) for field in ("main_url", "backup_url_1", "backup_url")]
            urls = list(dict.fromkeys(url for url in urls if url))
            downloaded = False
            for url in urls:
                self._cancel(cancelled)
                try:
                    self.source_downloader.download(url,encrypted,lambda:self._cancel(cancelled))
                    downloaded = True
                    break
                except ProviderError:
                    raise
                except Exception:
                    continue
            if not downloaded:
                raise ProviderError("MEDIA_DOWNLOAD_FAILED", "播放源连接失败，请重试当前集")
            self._cancel(cancelled)
            encryption = track.get("encrypt_info") or {}
            if encryption.get("encrypt"):
                from vendor import unwrap_spade, mp4_samples, decrypt
                spade = encryption.get("spade_a")
                keys = [unwrap_spade.spade_to_key(spade, flag) for flag in (0, 1)]
                keys = [key for key in keys if isinstance(key, str) and re.fullmatch(r"[0-9a-f]{32}", key)]
                key_hex, _ = mp4_samples.verify_key_iv(str(encrypted), keys, decrypt.senc_iv8(str(encrypted)))
                if not key_hex:
                    raise ProviderError("MEDIA_DECRYPT_FAILED", "这集播放源暂时无法解码，请更换清晰度后重试")
                stats = decrypt.decrypt_av(str(encrypted), key_hex, str(raw))
                if "vide" not in stats or stats["vide"][0] != stats["vide"][1]:
                    raise ProviderError("MEDIA_DECRYPT_FAILED", "播放源校验失败，请重试当前集")
                self._remux(raw, partial, cancelled)
            else:
                os.replace(encrypted, partial)
            self._cancel(cancelled)
            os.replace(partial, out)
            with self._source_guard:
                self._leases[str(out)] = self._leases.get(str(out), 0) + 1
            self._prune_sources()
            return out
        finally:
            for path in (encrypted, raw, partial):
                path.unlink(missing_ok=True)
            with self._source_guard:
                self._sources_running.discard(key)
                self._source_guard.notify_all()

    def _remux(self, raw, output, cancelled):
        import av
        with av.open(str(raw)) as input_file, av.open(str(output), "w", format="mp4", options={"movflags": "+faststart"}) as output_file:
            streams = {}
            for stream in input_file.streams:
                if stream.type in {"video", "audio"}:
                    target = output_file.add_stream_from_template(stream)
                    if stream.codec_context.name == "hevc":
                        target.codec_context.codec_tag = "hvc1"
                    streams[stream.index] = target
            if not streams:
                raise ProviderError("MEDIA_DECRYPT_FAILED", "这集没有有效的音视频轨道")
            for packet in input_file.demux():
                self._cancel(cancelled)
                if packet.dts is not None and packet.stream.index in streams:
                    packet.stream = streams[packet.stream.index]
                    output_file.mux(packet)

    def release_source(self, path):
        with self._source_guard:
            text = str(path)
            left = self._leases.get(text, 0) - 1
            if left > 0:
                self._leases[text] = left
            else:
                self._leases.pop(text, None)
        self._prune_sources()

    def _prune_sources(self):
        with self._source_guard:
            files = sorted(self.source_dir.glob("*.mp4"), key=lambda path: path.stat().st_mtime)
            total = sum(path.stat().st_size for path in files)
            count = len(files)
            for path in files:
                if total <= 512 * 1024 * 1024 and count <= 8:
                    break
                if str(path) in self._leases:
                    continue
                size = path.stat().st_size
                path.unlink(missing_ok=True)
                total, count = total - size, count - 1

    def close(self):
        self._closed.set()
        self.qr_login.close()
        self.seasons.clear()
        self.catalog_cache.close()
        with self._source_guard:
            self._source_guard.notify_all()
