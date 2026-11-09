"""Official Hongguo QR login with a verified mobile account handover.

Only the QR image and an unrelated local attempt ID cross the UI boundary.
Official polling tokens, cookies and redirect tickets stay in memory.  A web
confirmation becomes a saved account only after the existing signed mobile
account, history and bookshelf reads all succeed.
"""
from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass, field
import re
import secrets
import threading
import time
from urllib.parse import urljoin, urlsplit

import requests


ORIGIN = "https://hongguoduanju.com"
WEB_AID = "513755"
POLL_SECONDS = 1.5
MAX_IMAGE_BYTES = 512 * 1024
AUTH_COOKIES = {"sessionid", "sessionid_ss", "sid_tt", "sid_guard", "sid_ucp_v1", "ssid_ucp_v1", "tt_sessionid"}
COOKIE_NAMES = AUTH_COOKIES | {"uid_tt", "uid_tt_ss", "passport_csrf_token", "passport_csrf_token_default",
                            "passport_auth_status", "passport_auth_status_ss"}
TRUSTED_HOSTS = {"hongguoduanju.com", "www.hongguoduanju.com", "security.snssdk.com"}
TERMINAL = {"confirmed", "expired", "cancelled", "failed"}


class QrLoginError(Exception):
    def __init__(self, code, message, status=502):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def _text(value, limit=8192):
    return isinstance(value, str) and 0 < len(value) <= limit and not any(ord(c) < 32 for c in value)


def _image(value):
    if not isinstance(value, str) or len(value) > MAX_IMAGE_BYTES * 2:
        raise QrLoginError("QR_INVALID_RESPONSE", "官网返回的二维码格式不正确")
    if value.startswith("data:"):
        value = value.split(",", 1)[-1]
    try:
        data = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise QrLoginError("QR_INVALID_RESPONSE", "官网返回的二维码格式不正确") from None
    kind = "png" if data.startswith(b"\x89PNG\r\n\x1a\n") else "jpeg" if data.startswith(b"\xff\xd8\xff") else ""
    if not kind or len(data) > MAX_IMAGE_BYTES:
        raise QrLoginError("QR_INVALID_RESPONSE", "官网返回的二维码格式不正确")
    return f"data:image/{kind};base64,{base64.b64encode(data).decode('ascii')}"


def _data(response):
    if response.status_code != 200:
        raise QrLoginError("QR_NETWORK", "暂时无法连接红果扫码登录服务，请稍后重试")
    if len(response.content) > 2 * MAX_IMAGE_BYTES:
        raise QrLoginError("QR_INVALID_RESPONSE", "扫码登录服务返回异常，请刷新二维码")
    try:
        payload = response.json()
    except (ValueError, TypeError):
        raise QrLoginError("QR_INVALID_RESPONSE", "扫码登录服务返回异常，请刷新二维码") from None
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        raise QrLoginError("QR_INVALID_RESPONSE", "扫码登录服务返回异常，请刷新二维码")
    if data.get("captcha"):
        raise QrLoginError("QR_VERIFICATION_REQUIRED", "官网要求额外安全验证，请稍后刷新或使用验证码登录")
    error = data.get("error_code", payload.get("code", 0))
    if error not in (0, "0", None):
        if error in (2035, "2035"):
            raise QrLoginError("QR_EXPIRED", "二维码已失效，请刷新二维码", 410)
        raise QrLoginError("QR_UPSTREAM_REJECTED", "官网暂时无法完成扫码登录，请刷新或使用验证码登录")
    return data


def _trusted_redirect(value):
    if not _text(value, 16384):
        raise QrLoginError("QR_INVALID_REDIRECT", "扫码登录的授权地址无效")
    value = urljoin(ORIGIN + "/", value)
    try:
        parsed = urlsplit(value)
        valid = (parsed.scheme == "https" and parsed.hostname in TRUSTED_HOSTS
                 and parsed.port in (None, 443) and not parsed.username and not parsed.password
                 and (parsed.path == "/" or parsed.path.startswith("/passport/")))
    except ValueError:
        valid = False
    if not valid:
        raise QrLoginError("QR_INVALID_REDIRECT", "扫码登录的授权地址无效")
    return value


class OfficialQrTransport:
    """One isolated requests cookie jar per attempt; no browser dependency."""
    def __init__(self, session=None):
        self.http = session or requests.Session()
        self.http.trust_env = False
        self.http.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            "Origin": ORIGIN, "Referer": ORIGIN + "/", "Accept": "application/json"})
        # These are the values observed in the official login SDK's requests.
        self.params = {"aid": WEB_AID, "next": ORIGIN + "/", "language": "zh", "is_from_ttaccountsdk": "1",
                       "passport_jssdk_version": "2.4.13", "passport_jssdk_type": "normal", "account_sdk_source": "web"}

    def _get(self, url, params=None):
        try:
            return self.http.get(url, params=params, timeout=(8, 20), allow_redirects=False)
        except Exception:
            # Request exceptions can contain tokens in their URLs.
            raise QrLoginError("QR_NETWORK", "暂时无法连接红果扫码登录服务，请稍后重试") from None

    def create(self):
        data = _data(self._get(ORIGIN + "/passport/web/get_qrcode/", self.params))
        if not _text(data.get("token")):
            raise QrLoginError("QR_INVALID_RESPONSE", "扫码登录服务没有返回有效二维码，请刷新")
        return {"token": data["token"], "imageDataUrl": _image(data.get("qrcode")), "expiresAt": data.get("expire_time")}

    def poll(self, context):
        return _data(self._get(ORIGIN + "/passport/web/check_qrconnect/", {**self.params, "token": context["token"]}))

    def candidate(self, data):
        """Complete the official redirect and extract authentication cookies only."""
        token = ""
        redirect = data.get("redirect_url")
        if redirect:
            target = _trusted_redirect(redirect)
            for _ in range(6):
                response = self._get(target)
                header_token = response.headers.get("x-tt-token")
                if _text(header_token):
                    token = header_token
                if response.status_code in (301, 302, 303, 307, 308):
                    target = _trusted_redirect(urljoin(target, response.headers.get("location", "")))
                    continue
                if response.status_code != 200:
                    raise QrLoginError("QR_AUTHORIZATION_FAILED", "手机已确认，但官网登录授权暂时无法完成，请重试")
                break
            else:
                raise QrLoginError("QR_AUTHORIZATION_FAILED", "手机已确认，但官网登录授权暂时无法完成，请重试")
        cookies = {}
        for cookie in self.http.cookies:
            if (cookie.name in COOKIE_NAMES and cookie.domain.lstrip(".") in TRUSTED_HOSTS
                    and _text(cookie.value, 8192)):
                cookies[cookie.name] = cookie.value
        if not token and not any(cookies.get(name) for name in AUTH_COOKIES):
            raise QrLoginError("QR_INCOMPLETE_SESSION", "手机已确认，但官网没有返回可用登录态，请重新扫码")
        return {"cookie": "; ".join(f"{name}={value}" for name, value in sorted(cookies.items())), "token": token}

    def close(self):
        self.http.cookies.clear()
        self.http.close()


def verify_mobile_session(account, candidate):
    """Read through the existing signer without installing a tentative account."""
    candidate = dict(candidate)
    try:
        info = account._json(account._call("GET", "/reading/user/info/v", session=candidate))
        user = info.get("data") if isinstance(info, dict) else None
        uid = str(user.get("user_id") or user.get("user_id_str") or user.get("uid") or "") if isinstance(user, dict) else ""
        if (info.get("code") not in (0, "0") or uid in ("0", "-1")
                or user.get("is_login") is False or not re.fullmatch(r"[A-Za-z0-9#_+./=-]{1,512}", uid)):
            raise QrLoginError("QR_MOBILE_SESSION_UNAVAILABLE", "扫码账号暂时无法连接手机账号数据，请使用验证码登录")
        candidate.update(uid=uid, user_name=str(user.get("user_name") or user.get("name") or "")[:200], saved_at=int(time.time()))
        history = account._json(account._call("GET", "/reading/bookapi/read_history/list/v", extra={
            "book_type": "2", "offset": "0", "limit": "1", "query_soft_deleted": "false", "is_first_load": "false",
            "last_min_read_timestamp_ms": "0", "full_field": "false"}, session=candidate))
        shelf = account._json(account._call("GET", "/reading/bookapi/bookshelf/video/list/v", session=candidate))
        for payload, key in ((history, "data_list"), (shelf, "video_shelf_info")):
            data = payload.get("data") if isinstance(payload, dict) else None
            if (not isinstance(payload, dict) or payload.get("code") not in (0, "0") or not isinstance(data, dict)
                    or not isinstance(data.get(key, []), list)):
                raise QrLoginError("QR_MOBILE_SESSION_UNAVAILABLE", "扫码账号暂时无法读取手机历史或收藏，请重试或使用验证码登录")
    except QrLoginError:
        raise
    except Exception:
        raise QrLoginError("QR_MOBILE_SESSION_UNAVAILABLE", "扫码账号暂时无法连接手机账号数据，请重试或使用验证码登录") from None
    return candidate


@dataclass(repr=False)
class _Attempt:
    id: str
    origin_identity: str = field(repr=False)
    transport: object = field(repr=False)
    context: dict = field(default_factory=dict, repr=False)
    status: str = "waiting"
    expires_at: float = 0
    deadline: float = 0
    next_poll: float = 0
    inflight: bool = False
    message: str = "使用红果短剧 App 扫码登录"
    error: str = ""
    session: dict = field(default_factory=dict, repr=False)


class QrLoginManager:
    def __init__(self, account, commit_session, current_identity, transport_factory=OfficialQrTransport,
                 clock=time.monotonic, wall_clock=time.time):
        self.account, self.commit_session, self.current_identity = account, commit_session, current_identity
        self.transport_factory, self.clock, self.wall_clock = transport_factory, clock, wall_clock
        self._lock = threading.RLock()
        self._attempt = None
        self._closed = False

    @staticmethod
    def _public(attempt, include_image=False):
        result = {"id": attempt.id, "status": attempt.status, "expiresAt": attempt.expires_at,
                  "pollAfter": POLL_SECONDS, "message": attempt.message}
        if include_image and attempt.status in ("waiting", "scanned"):
            result["imageDataUrl"] = attempt.context.get("imageDataUrl", "")
        if attempt.error:
            result["error"] = {"code": attempt.error, "message": attempt.message}
        if attempt.status == "confirmed":
            result["session"] = attempt.session
        return result

    @staticmethod
    def _discard(attempt):
        attempt.context.clear()
        try:
            attempt.transport.close()
        except Exception:
            pass

    def _finish(self, attempt, status, message, error=""):
        attempt.status, attempt.message, attempt.error = status, message, error
        self._discard(attempt)

    def _active(self, attempt):
        return not self._closed and self._attempt is attempt and attempt.status not in TERMINAL

    def _identity_changed(self, attempt):
        return self.current_identity() != attempt.origin_identity

    def _valid(self, attempt):
        if not self._active(attempt):
            return False
        if self._identity_changed(attempt):
            self._finish(attempt, "cancelled", "账号已切换，已取消之前的扫码登录", "ACCOUNT_CHANGED")
            return False
        if self.clock() >= attempt.deadline:
            self._finish(attempt, "expired", "二维码已失效，请刷新二维码", "QR_EXPIRED")
            return False
        return True

    def create(self):
        with self._lock:
            if self._closed:
                raise QrLoginError("SERVICE_STOPPING", "播放服务正在退出", 503)
            if self._attempt and self._attempt.status not in TERMINAL:
                self._finish(self._attempt, "cancelled", "已取消之前的扫码登录")
            attempt = _Attempt(secrets.token_hex(16), self.current_identity(), self.transport_factory())
            # Provisional bounded lifetime while the first request is running.
            attempt.deadline = self.clock() + 60
            self._attempt = attempt
        try:
            context = attempt.transport.create()
            image = _image(context.get("imageDataUrl"))
            if not _text(context.get("token")):
                raise QrLoginError("QR_INVALID_RESPONSE", "扫码登录服务返回异常，请刷新二维码")
            now = self.wall_clock()
            try:
                expires_at = float(context.get("expiresAt"))
                ttl = expires_at - now
            except (ValueError, TypeError, OverflowError):
                ttl = 60
            if not 0 < ttl <= 600:
                raise QrLoginError("QR_EXPIRED", "二维码已失效，请刷新二维码", 410)
            with self._lock:
                if not self._active(attempt):
                    self._discard(attempt)
                    return self._public(attempt)
                if self._identity_changed(attempt):
                    self._finish(attempt, "cancelled", "账号已切换，已取消之前的扫码登录", "ACCOUNT_CHANGED")
                    return self._public(attempt)
                attempt.context = {"token": context["token"], "imageDataUrl": image}
                attempt.expires_at, attempt.deadline = now + ttl, self.clock() + ttl
                attempt.next_poll = self.clock() + POLL_SECONDS
                return self._public(attempt, True)
        except Exception as error:
            with self._lock:
                self._discard(attempt)
                if isinstance(error, QrLoginError):
                    self._finish(attempt, "failed", error.message, error.code)
                    raise
                self._finish(attempt, "failed", "暂时无法生成二维码，请稍后重试", "QR_NETWORK")
                raise QrLoginError("QR_NETWORK", attempt.message) from None

    def _lookup(self, id):
        if not isinstance(id, str) or not re.fullmatch(r"[a-f0-9]{32}", id):
            raise QrLoginError("INPUT_INVALID", "扫码登录标识不正确", 400)
        if not self._attempt or self._attempt.id != id:
            raise QrLoginError("QR_NOT_FOUND", "二维码已被刷新，请使用最新二维码", 404)
        return self._attempt

    def status(self, id):
        with self._lock:
            attempt = self._lookup(id)
            if not self._valid(attempt) or attempt.inflight or self.clock() < attempt.next_poll:
                return self._public(attempt)
            attempt.inflight = True
            context = dict(attempt.context)
        try:
            data = attempt.transport.poll(context)
            state = str(data.get("status") or "")
            with self._lock:
                if not self._valid(attempt):
                    return self._public(attempt)
                if state in ("1", "new", "2", "scanned"):
                    attempt.status = "scanned" if state in ("2", "scanned") else "waiting"
                    attempt.message = "已扫码，请在红果短剧 App 中确认登录" if attempt.status == "scanned" else "使用红果短剧 App 扫码登录"
                elif state in ("4",):
                    if not _text(data.get("token")):
                        raise QrLoginError("QR_INVALID_RESPONSE", "扫码登录服务返回异常，请刷新二维码")
                    attempt.context = {"token": data["token"], "imageDataUrl": _image(data.get("qrcode"))}
                    attempt.status = "waiting"
                    return self._public(attempt, True)
                elif state in ("5", "expired"):
                    self._finish(attempt, "expired", "二维码已失效，请刷新二维码", "QR_EXPIRED")
                elif state in ("6", "cancelled", "rejected"):
                    self._finish(attempt, "cancelled", "已取消扫码登录，请刷新二维码重试")
                elif state in ("3", "confirmed"):
                    attempt.status, attempt.message = "verifying", "手机已确认，正在连接历史与收藏"
                else:
                    raise QrLoginError("QR_INVALID_RESPONSE", "扫码登录状态异常，请刷新二维码")
            if state in ("3", "confirmed"):
                candidate = verify_mobile_session(self.account, attempt.transport.candidate(data))
                with self._lock:
                    if self._valid(attempt):
                        # The callback must atomically recheck origin_identity
                        # under Provider's account write lock before saving.
                        attempt.session = self.commit_session(candidate, attempt.origin_identity)
                        self._finish(attempt, "confirmed", "扫码登录成功，已连接手机历史与收藏")
            with self._lock:
                return self._public(attempt)
        except Exception as error:
            with self._lock:
                if self._active(attempt):
                    if isinstance(error, QrLoginError):
                        if error.code == "QR_NETWORK":
                            attempt.message = "网络暂时中断，正在重试…"
                        else:
                            self._finish(attempt, "expired" if error.code == "QR_EXPIRED" else "failed", error.message, error.code)
                    elif getattr(error, "code", "") == "ACCOUNT_CHANGED":
                        self._finish(attempt, "cancelled", "账号已切换，已取消之前的扫码登录", "ACCOUNT_CHANGED")
                    else:
                        self._finish(attempt, "failed", "扫码登录暂时无法完成，请刷新二维码重试", "QR_LOGIN_FAILED")
                return self._public(attempt)
        finally:
            context.clear()
            with self._lock:
                attempt.inflight = False
                attempt.next_poll = self.clock() + POLL_SECONDS

    def cancel(self, id):
        with self._lock:
            attempt = self._lookup(id)
            if attempt.status not in TERMINAL:
                self._finish(attempt, "cancelled", "已取消扫码登录")
            return self._public(attempt)

    def close(self):
        with self._lock:
            self._closed = True
            if self._attempt and self._attempt.status not in TERMINAL:
                self._finish(self._attempt, "cancelled", "已取消扫码登录")
