"""Official mobile timed-comment contract. Plain text and media time only."""
from __future__ import annotations
import json
import math
import re

WINDOW_SECONDS = 30


def milliseconds(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 86400:
        raise ValueError("Invalid media position")
    return int(round(value * 1000))


def list_request(series_id, vid, position, duration):
    """7.4.3 DanmakuRequestHelper: source 601/channel 1000/comment type 20."""
    start = int(position // WINDOW_SECONDS) * WINDOW_SECONDS
    return {"comment_source": 601, "server_channel": 1000, "group_id": vid,
            "group_type": 30, "comment_type": 20, "sort": 1, "count": 90,
            "cursor": "", "aid": 8662, "compliance_status": 0,
            "business_param": {"book_id": series_id, "start_offset_time": milliseconds(start),
                               "playlet_item_duration": milliseconds(duration), "need_danmaku_guide_type": []}}


def _media_ms(value, fallback=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 86400000:
        return fallback
    return float(value)


def page(response, series_id, vid, position, duration):
    """Keep genuine ordinary comments; never substitute wall time for a missing offset."""
    if not isinstance(response, dict) or response.get("code") not in (0, "0"):
        raise ValueError("Danmaku request failed")
    data = response.get("data")
    if not isinstance(data, dict) or not isinstance(data.get("data_list"), list):
        raise ValueError("Malformed danmaku response")
    info, extra = data.get("common_list_info") or {}, data.get("extra") or {}
    if not isinstance(info, dict) or not isinstance(extra, dict):
        raise ValueError("Malformed danmaku window")
    cursor = {}
    try:
        raw = info.get("cursor")
        if isinstance(raw, str) and len(raw) <= 16000:
            decoded = json.loads(raw)
            if isinstance(decoded, dict): cursor = decoded
    except (ValueError, TypeError):
        pass
    requested_start = milliseconds(int(position // WINDOW_SECONDS) * WINDOW_SECONDS)
    start = _media_ms(cursor.get("start_offset_time"), requested_start)
    end = _media_ms(extra.get("next_query_danmaku_list_time"),
                    _media_ms(cursor.get("end_offset_time"), start + WINDOW_SECONDS * 1000))
    if end <= start: end = start + WINDOW_SECONDS * 1000
    if duration > 0: end = min(end, milliseconds(duration))
    seen, items = set(), []
    for row in data["data_list"][:500]:
        if not isinstance(row, dict) or not isinstance(row.get("comment"), dict): continue
        comment = row["comment"]
        common, expand = comment.get("common") or {}, comment.get("expand") or {}
        if not isinstance(common, dict) or not isinstance(expand, dict): continue
        if str(common.get("group_id") or "") != vid or common.get("service_id") not in (20, "20"): continue
        if common.get("status") not in (1, "1"): continue
        content = common.get("content") or {}
        text = content.get("text") if isinstance(content, dict) else None
        identifier, at = str(comment.get("comment_id") or ""), _media_ms(expand.get("offset_time"))
        if not re.fullmatch(r"[0-9]{8,24}", identifier) or identifier in seen or not isinstance(text, str) or at is None: continue
        if at < start - 1000 or at >= end + 1000 or duration > 0 and at > milliseconds(duration): continue
        text = re.sub(r"[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]", "", text).strip()[:160]
        if not text: continue
        seen.add(identifier)
        items.append({"id": identifier, "text": text, "time": at / 1000})
    items.sort(key=lambda item: (item["time"], item["id"]))
    return {"items": items, "start": start / 1000, "end": max(start, end) / 1000,
            "hasMore": bool(info.get("has_more")) and (duration <= 0 or end < milliseconds(duration)),
            "seriesId": series_id, "vid": vid, "source": "mobile"}
