"""Reconcile shelf mutations without inferring cooldowns from an ambiguous business error."""
import time


def set_favorite(sid, desired, read, write, pause=None):
    pause = pause or time.sleep
    current = read()
    if not isinstance(current, dict) or not current.get("ok"):
        raise ValueError("暂时读不到收藏状态，请稍后重试")
    saved = any(str(item.get("seriesId") or item.get("series_id") or "") == sid for item in current.get("items") or [])
    if saved == desired:
        return {"synced": True, "favorite": desired}
    result = write(sid, desired)
    if result.get("ok"):
        return {"synced": True, "favorite": desired}
    # Only read-back is retried; never replay writes during an upstream rejection.
    for delay in (0, 1, 2):
        if delay:
            pause(delay)
        page = read()
        if isinstance(page, dict) and page.get("ok"):
            actual = any(str(item.get("seriesId") or item.get("series_id") or "") == sid for item in page.get("items") or [])
            if actual == desired:
                return {"synced": True, "favorite": desired}
    code = result.get("code")
    raise ValueError("收藏暂时未同步，请稍后重试" + (f"（{code}）" if isinstance(code, int) else ""))
