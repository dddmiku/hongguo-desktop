"""Official series-album rankings, separate from ordinary catalog genres."""
import re
import uuid
from urllib.parse import parse_qs, urlsplit


CELL_ID = "7470092475068071998"
BOARDS = {"recommend": "series_album_hot_sc", "new": "series_album_new_rank"}
_ID = re.compile(r"[0-9]{8,24}")


def _entry(video):
    """Use the mobile app's detail destination, without opening upstream schemas."""
    if not isinstance(video, dict):
        return None
    current = str(video.get("series_id") or video.get("book_id") or "")
    if not _ID.fullmatch(current):
        return None
    target = current
    try:
        schema = urlsplit(str(video.get("jump_schema") or ""))
        values = parse_qs(schema.query).get("video_series_id", [])
        if (schema.scheme == "dragon8662" and schema.netloc.lower() == "videodetail"
                and schema.path in ("", "/") and len(values) == 1 and _ID.fullmatch(values[0])):
            target = values[0]
    except ValueError:
        pass
    subtitles = video.get("sub_title_list")
    tags = [str(row.get("content") or "").strip()[:80]
            for row in subtitles if isinstance(row, dict)] if isinstance(subtitles, list) else []
    recommendation = video.get("rec_text_item")
    heat = str(recommendation.get("RecommendText") or "").strip()[:80] if isinstance(recommendation, dict) else ""
    tags = list(dict.fromkeys(tag for tag in [*tags, heat] if tag))[:12]
    return {"series_id": target, "title": video.get("title") or "", "cover": video.get("cover") or "",
            "intro": video.get("video_desc") or "", "tags": tags,
            # Rank rows describe the newest season, while the official jump can
            # point at season one. Only detail may supply that target's counts.
            "episode_cnt": video.get("episode_cnt", 0) if target == current else 0,
            "score": video.get("score", "") if target == current else ""}


def read_series_rank_page(sdk, board="recommend", continuation=None):
    """Read one complete official page and preserve its ranking session."""
    if board not in BOARDS:
        raise ValueError("Unsupported series ranking")
    state = continuation or {"offset": 0, "session_uuid": str(uuid.uuid4())}
    offset = state["offset"]
    query = {"cell_id": CELL_ID, "tab_type": "26", "client_req_type": "2",
             "client_template": "2", "screen_width_px": "1350", "selected_items": "series_album",
             "sub_selected_items": BOARDS[board], "session_uuid": state["session_uuid"]}
    if offset:
        query["offset"] = str(offset)
    for name in ("session_id", "rank_version"):
        if state.get(name):
            query[name] = state[name]
    response = sdk.api("GET", "/reading/bookapi/bookmall/cell/change/v", extra_query=query, signed=True)
    data = response.get("data") if isinstance(response, dict) else None
    view = data.get("cell_view") if isinstance(data, dict) else None
    cells = view.get("cell_data") if isinstance(view, dict) else None
    if not isinstance(response, dict) or response.get("code") not in (0, "0") or not isinstance(cells, list):
        raise ValueError("Series ranking response is incomplete")
    rows, seen = [], set()
    for cell in cells:
        videos = cell.get("video_data") if isinstance(cell, dict) else None
        video = videos[0] if isinstance(videos, list) and videos else videos
        item = _entry(video)
        if item is not None and item["series_id"] not in seen:
            seen.add(item["series_id"])
            rows.append(item)
    more = view.get("has_more", data.get("has_more", False)) in (True, 1, "1", "true")
    next_offset = view.get("next_offset", data.get("next_offset", offset + len(cells)))
    valid_offset = re.fullmatch(r"[0-9]{1,6}", str(next_offset)) is not None
    next_offset = int(next_offset) if valid_offset else offset
    has_more = bool(cells) and more and offset < next_offset <= 100000
    next_state = {**state, "offset": next_offset}
    # session_uuid is the client's request identity. session_id is a distinct
    # server-issued continuation: omitting it repeats the recommendation tail.
    for name in ("session_id", "rank_version"):
        value = data.get(name) or view.get(name) or state.get(name) or ""
        if not isinstance(value, (str, int)) or isinstance(value, bool) or len(str(value)) > 1024:
            raise ValueError("Series ranking continuation is invalid")
        next_state[name] = str(value)
    return {"items": rows, "hasMore": has_more, "continuation": next_state,
            "warning": "榜单分页暂时异常，已保留片单，请刷新重试" if more and not has_more else ""}
