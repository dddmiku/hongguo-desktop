"""Small isolated helpers for the local, read-only gateway timing harness."""
from pathlib import Path
import threading
import uuid


def create_run_profile(work: Path, run: int) -> Path:
    """Give every measurement run a fresh data root and therefore a cold catalog cache."""
    profile = work / ("run-%d-%s" % (run, uuid.uuid4().hex))
    profile.mkdir(parents=True, exist_ok=False)
    return profile


def read_ready(process, timeout: float = 30.0, on_timeout=None) -> dict:
    """Read the gateway's first readiness line with a bounded wait."""
    lines = []
    reader = threading.Thread(target=lambda: lines.append(process.stdout.readline()), daemon=True)
    reader.start()
    reader.join(timeout)
    if reader.is_alive():
        if on_timeout is None:
            process.kill()
        else:
            on_timeout()
        process.wait(timeout=10)
        raise TimeoutError("Gateway startup timeout")
    if not lines or not lines[0]:
        raise RuntimeError("Gateway exited before readiness")
    import json
    return json.loads(lines[0])
