"""Private loopback gateway, supervised by Electron's stdin pipe.

No original desktop server is imported. Each launch owns a random API port,
its signer process and the new media manager; all are closed on parent EOF.
"""
from __future__ import annotations

import ctypes
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import socket
import struct
import subprocess
import sys
import threading
import time

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent))
from provider import Provider, ProviderError


def product_version():
    version = os.environ.get("HG_APP_VERSION")
    if version:
        return version
    try:
        metadata = Path(__file__).resolve().parents[1] / "package.json"
        value = json.loads(metadata.read_text(encoding="utf-8")).get("version")
        if isinstance(value, str) and value:
            return value
    except (OSError, ValueError, AttributeError):
        pass
    return "1.0.0"


def create_app(provider, token, media_manager=None, signer_ok=lambda: True):
    app = FastAPI(title="红果桌面播放服务", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        supplied = request.headers.get("authorization", "")
        supplied = supplied[7:] if supplied.startswith("Bearer ") else ""
        api_authorized = bool(re.fullmatch(r"[a-f0-9]{64}", supplied)) and hmac.compare_digest(supplied, token)
        media_authorized = False
        # Renderer-visible URLs carry a separate capability for media files only.
        # That capability cannot access account APIs or create/change sessions.
        if (media_manager is not None and request.method == "GET" and
                re.fullmatch(r"/media/session/[A-Za-z0-9_-]+/(?:index\.m3u8|init\.mp4|seg[0-9]{6}\.m4s)", request.url.path)):
            media_supplied = request.query_params.get("token", "")
            media_authorized = (bool(re.fullmatch(r"[a-f0-9]{64}", media_supplied)) and
                                hmac.compare_digest(media_supplied, media_manager.token))
        if not api_authorized and not media_authorized:
            return JSONResponse({"error": {"code": "UNAUTHORIZED", "message": "播放服务连接凭据已失效，请重新打开客户端"}}, status_code=401)
        try:
            if int(request.headers.get("content-length", "0")) > 65536:
                return JSONResponse({"error": {"code": "INPUT_TOO_LARGE", "message": "请求内容过大"}}, status_code=413)
        except ValueError:
            return JSONResponse({"error": {"code": "INPUT_INVALID", "message": "请求格式不正确"}}, status_code=400)
        return await call_next(request)

    @app.exception_handler(ProviderError)
    async def provider_error(request, error):
        return JSONResponse({"error": {"code": error.code, "message": error.message}}, status_code=error.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse({"error": {"code": "INPUT_INVALID", "message": "请求参数格式不正确"}}, status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, error):
        # Media errors are fixed messages under our control, never upstream bodies.
        detail = error.detail
        if isinstance(detail, dict) and isinstance(detail.get("error"), dict):
            payload = detail
        else:
            message = "播放资源暂时不可用" if error.status_code >= 500 else "请求的资源不存在或参数不正确"
            payload = {"error": {"code": "RESOURCE_UNAVAILABLE" if error.status_code >= 500 else "RESOURCE_NOT_FOUND", "message": message}}
        return JSONResponse(payload, status_code=error.status_code)

    @app.exception_handler(Exception)
    async def unknown_error(request, error):
        return JSONResponse({"error": {"code": "INTERNAL_ERROR", "message": "播放服务暂时无法处理请求，请重试"}}, status_code=500)

    @app.get("/health")
    def health():
        ok = bool(signer_ok())
        return {"ok": ok, "version": product_version(), "signer": ok,
                **({"error": "签名服务已停止，请重新打开客户端"} if not ok else {})}

    @app.get("/catalog/home")
    def home(genre: str = Query("short_play", max_length=32), cursor: str = Query("", max_length=1024),
             mode: str = Query("discover", max_length=32), refresh: bool = Query(False)):
        return provider.home(genre, cursor, mode, refresh=refresh)

    @app.get("/catalog/search")
    def search(q: str = Query(..., min_length=1, max_length=80)):
        return provider.search(q)

    @app.get("/catalog/rank")
    def rank(board: str = Query("hot", max_length=32), genre: str = Query("short_play", max_length=32)):
        return provider.rank(board, genre)

    @app.get("/catalog/browse")
    def browse(genre: str = Query("short_play", max_length=32), sort: str = Query("hot_score", max_length=32),
               theme: str = Query("", max_length=80), setting: str = Query("", max_length=80),
               background: str = Query("", max_length=80), cursor: str = Query("", max_length=80)):
        return provider.browse(genre, sort, theme, setting, background, cursor)

    @app.get("/catalog/filters")
    def filters(genre: str = Query("short_play", max_length=32)):
        return provider.filters(genre)

    @app.get("/catalog/series/{series_id}")
    def detail(series_id: str):
        return provider.detail(series_id)

    @app.get("/catalog/comments")
    def comments(seriesId: str = Query(..., min_length=8, max_length=24), episode: int = Query(..., ge=1, le=100000),
                 cursor: int = Query(0, ge=0, le=1000000)):
        return provider.comments(seriesId, episode, cursor)

    @app.get("/account/session")
    def session():
        return provider.session()

    @app.post("/account/send-code")
    def send_code(payload: dict = Body(...)):
        return provider.send_code(payload.get("mobile", ""))

    @app.post("/account/login")
    def login(payload: dict = Body(...)):
        return provider.login(payload.get("mobile", ""), payload.get("code", ""))

    @app.post("/account/logout")
    def logout():
        return provider.logout()

    @app.post("/account/mfa/send")
    def mfa_send(payload: dict = Body(...)):
        return provider.mfa_send(payload.get("mobile", ""), payload.get("code", ""), payload.get("challengeId", ""))

    @app.post("/account/mfa/verify")
    def mfa_verify(payload: dict = Body(...)):
        return provider.mfa_verify(payload.get("mobile", ""), payload.get("code", ""), payload.get("challengeId", ""))

    @app.post("/account/import")
    def import_session(payload: dict = Body(...)):
        return provider.import_session(payload.get("session"))

    @app.get("/account/history")
    def history(cursor: str = Query("", max_length=2048), limit: int = Query(100, ge=1, le=500), refresh: bool = Query(False)):
        return provider.history(cursor, limit, refresh)

    @app.get("/account/favorites")
    def favorites():
        return provider.favorites()

    @app.post("/account/progress")
    def progress(payload: dict = Body(...)):
        return provider.progress(payload)

    @app.post("/account/favorite")
    def favorite(payload: dict = Body(...)):
        if not isinstance(payload.get("favorite"), bool):
            raise ProviderError("INPUT_INVALID", "收藏状态不正确", 400)
        return provider.favorite(payload.get("seriesId"), payload["favorite"], payload.get("expectedUid"))

    if media_manager is not None:
        from media import mount_media
        mount_media(app, media_manager)
    return app


class TcpRow(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint32) for name in ("state", "address", "port", "remote_address", "remote_port", "pid")]


def owned_listener(pid):
    """Read Windows TCP owner table, so an unrelated fixed port is never reused."""
    library = ctypes.WinDLL("iphlpapi.dll", winmode=0x00000800)
    query = library.GetExtendedTcpTable
    query.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_int,
                      ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    query.restype = ctypes.c_uint32
    size = ctypes.c_uint32()
    code = query(None, ctypes.byref(size), False, socket.AF_INET, 3, 0)
    if code not in (0, 122) or not 4 <= size.value <= 1024 * 1024:
        raise RuntimeError("Cannot inspect signer endpoint")
    for _ in range(4):
        buffer = ctypes.create_string_buffer(size.value)
        code = query(buffer, ctypes.byref(size), False, socket.AF_INET, 3, 0)
        if code == 122:
            continue
        if code != 0:
            raise RuntimeError("Cannot inspect signer endpoint")
        count = ctypes.c_uint32.from_buffer_copy(buffer).value
        stride = ctypes.sizeof(TcpRow)
        if 4 + count * stride > len(buffer):
            raise RuntimeError("Invalid signer endpoint table")
        ports = []
        for index in range(count):
            row = TcpRow.from_buffer_copy(buffer, 4 + index * stride)
            if row.pid == pid and row.state == 2:
                address = socket.inet_ntoa(struct.pack("=I", row.address))
                if address != "127.0.0.1":
                    raise RuntimeError("Signer must bind loopback")
                ports.append(socket.ntohs(row.port & 65535))
        if len(ports) > 1:
            raise RuntimeError("Ambiguous signer endpoint")
        return ports[0] if ports else None
    raise RuntimeError("Signer endpoint table changed")


class OwnedSigner:
    def __init__(self, runtime_dir: Path):
        self.root = runtime_dir
        self.process = None
        self.stdout_port = None

    def start(self, stop):
        java = self.root / "jre" / "bin" / ("java.exe" if os.name == "nt" else "java")
        jar = self.root / "sign" / "unidbg-sign.jar"
        if not java.is_file() or not jar.is_file():
            raise RuntimeError("Signing runtime is missing")
        self.process = subprocess.Popen([str(java), "-Djava.net.preferIPv4Stack=true", "--add-opens",
            "java.base/java.lang=ALL-UNNAMED", "-Xmx512m", "-XX:+ExitOnOutOfMemoryError", "-cp", str(jar),
            "com.hongguo.sign.FqTrace", "serve", "0"], cwd=jar.parent, stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

        def drain():
            for line in iter(self.process.stdout.readline, b""):
                text = line.decode("utf-8", "replace")
                match = re.search(r"(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})", text)
                if match:
                    self.stdout_port = int(match.group(1))
        threading.Thread(target=drain, daemon=True, name="signer-output").start()
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline and not stop.is_set():
            if self.process.poll() is not None:
                raise RuntimeError("Signing process exited")
            port = owned_listener(self.process.pid) if os.name == "nt" else self.stdout_port
            if port:
                return f"http://127.0.0.1:{port}"
            stop.wait(.05)
        raise RuntimeError("Signing startup was interrupted or timed out")

    def alive(self):
        return self.process is not None and self.process.poll() is None

    def close(self):
        process = self.process
        if process is None:
            return
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def main():
    data = Path(os.environ["HG_DATA_DIR"])
    runtime = Path(os.environ["HG_RUNTIME_DIR"])
    token = os.environ.get("HG_API_TOKEN", "")
    if not data.is_absolute() or not runtime.is_absolute() or not re.fullmatch(r"[a-f0-9]{64}", token):
        raise RuntimeError("Managed desktop launch is required")
    stop, finished = threading.Event(), threading.Event()
    signer = OwnedSigner(runtime)
    state = {"server": None, "provider": None, "media": None}

    def shutdown():
        stop.set()
        signer.close()
        if state["provider"]:
            state["provider"].close()
        if state["media"]:
            state["media"].close()
        if state["server"]:
            state["server"].should_exit = True

    def parent_watch():
        try:
            while sys.stdin.buffer.read(1):
                pass
        finally:
            stop.set()
            # Terminate the signer before waiting for any slow download worker.
            signer.close()
            if state["provider"]:
                state["provider"].close()
            if state["server"]:
                state["server"].should_exit = True
            # A blocked upstream worker must not leave a process after its parent.
            finished.wait(4)
            os._exit(0)
    threading.Thread(target=parent_watch, daemon=True, name="electron-parent").start()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    listener.setblocking(False)
    port = listener.getsockname()[1]
    try:
        signer_url = signer.start(stop)
        if stop.is_set():
            return
        provider = Provider.from_runtime(data, runtime, signer_url)
        state["provider"] = provider
        from media import MediaManager
        import uvicorn
        ffmpeg = runtime / "ffmpeg" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if not ffmpeg.is_file():
            ffmpeg = runtime / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        manager = MediaManager(provider, data, ffmpeg, secrets.token_hex(32))
        state["media"] = manager
        server = uvicorn.Server(uvicorn.Config(create_app(provider, token, manager, signer.alive),
            host="127.0.0.1", port=port, log_config=None, access_log=False, log_level="critical",
            timeout_graceful_shutdown=2))
        state["server"] = server

        def announce():
            while not stop.wait(.02):
                if server.started:
                    sys.stdout.write(json.dumps({"type": "ready", "port": port}) + "\n")
                    sys.stdout.flush()
                    break
        threading.Thread(target=announce, daemon=True, name="gateway-ready").start()

        def signer_watch():
            while not stop.wait(.25):
                if not signer.alive():
                    shutdown()
                    return
        threading.Thread(target=signer_watch, daemon=True, name="signer-watch").start()
        server.run(sockets=[listener])
    finally:
        shutdown()
        listener.close()
        finished.set()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Fixed exception type only: no URLs, account details, tokens or upstream bodies.
        sys.stderr.write("Gateway startup failed: " + type(error).__name__ + "\n")
        sys.exit(1)
