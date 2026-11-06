"""Desktop seconds ↔ mobile history milliseconds. No HTTP or account access."""
from __future__ import annotations

import math
import re
import time


def epoch_seconds(value, default=None):
    """Accept seconds from desktop and milliseconds from existing mobile history."""
    if value is None:
        value = time.time() if default is None else default
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError("Invalid viewing timestamp")
    return float(value) / 1000 if value >= 100_000_000_000 else float(value)


def seconds_to_ms(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 86400:
        raise ValueError("Invalid media time")
    return int(round(float(value) * 1000))


def mobile_position_seconds(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        return 0.0
    return float(value) / 1000


def build_progress_item(series, episode, vid, position_seconds, duration_seconds, watched_at, total):
    sid = str(series.get("id") or "")
    if not re.fullmatch(r"[0-9]{8,24}", sid) or not re.fullmatch(r"[0-9]{8,24}", str(vid)):
        raise ValueError("Invalid series or video identifier")
    if isinstance(episode, bool) or not isinstance(episode, int) or not 1 <= episode <= 100000:
        raise ValueError("Invalid episode index")
    watched_seconds = epoch_seconds(watched_at)
    if watched_seconds > time.time() + 60:
        raise ValueError("Viewing timestamp is in the future")
    position_ms, duration_ms = seconds_to_ms(position_seconds), seconds_to_ms(duration_seconds)
    # Fields follow the mobile read_history/update/v body and the old verified SDK.
    return {"book_id": int(sid), "book_id_str": sid, "book_type": 2, "vid": int(vid),
            "vid_index": episode, "chapter_index": episode, "read_timestamp_ms": int(round(watched_seconds * 1000)),
            "update_timestamp_ms": 0, "current_play_position": position_ms,
            "player_accumulate_total_time": position_ms, "duration": duration_ms,
            "episode_cnt": max(0, int(total)), "is_delete": False, "use_soft_delete": False,
            "genre_type": 2150, "book_name": str(series.get("title") or "")[:120],
            "thumb_url": str(series.get("cover") or "")[:400]}


def build_playback_progress_item(history_item):
    """Official 7.4.3 VideoProgressUploadHelp's independent resume contract.

    This receives the already validated viewing action so both stores have the
    same video, position and timestamp. ProgressRateInfo uses strings for IDs
    and current_play_time in milliseconds, unlike ReadHistoryData's fields.
    """
    return {"book_id": history_item["book_id_str"], "book_type": 2,
            "item_id": str(history_item["vid"]), "vid_index": history_item["vid_index"],
            "read_timestamp_ms": history_item["read_timestamp_ms"],
            "current_play_time": history_item["current_play_position"],
            "player_cumulative_total_duration": history_item["player_accumulate_total_time"]}
