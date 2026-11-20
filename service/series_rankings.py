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


def read_series_rank(sdk, board="recommend", limit=50):
    if board not in BOARDS:
        raise ValueError("Unsupported series ranking")
    limit = max(1, min(100, int(limit)))
    rows, seen, offset = [], set(), 0
    session = str(uuid.uuid4())
    # The official page currently contains ten cells. A bounded allowance for
    # invalid/duplicate cells prevents an upstream has_more loop from hanging.
    for _ in range(min(20, (limit + 9) // 10 + 5)):
        query = {"cell_id": CELL_ID, "tab_type": "26", "client_req_type": "2",
                 "client_template": "2", "screen_width_px": "1350", "selected_items": "series_album",
                 "sub_selected_items": BOARDS[board], "session_uuid": session}
        if offset:
            query["offset"] = str(offset)
        response = sdk.api("GET", "/reading/bookapi/bookmall/cell/change/v", extra_query=query, signed=True)
        data = response.get("data") if isinstance(response, dict) else None
        view = data.get("cell_view") if isinstance(data, dict) else None
        cells = view.get("cell_data") if isinstance(view, dict) else None
        if not isinstance(response, dict) or response.get("code") not in (0, "0") or not isinstance(cells, list):
            raise ValueError("Series ranking response is incomplete")
        for cell in cells:
            videos = cell.get("video_data") if isinstance(cell, dict) else None
            video = videos[0] if isinstance(videos, list) and videos else videos
            item = _entry(video)
            if item is not None and item["series_id"] not in seen:
                seen.add(item["series_id"])
                rows.append(item)
                if len(rows) == limit:
                    return rows
        if not cells or not view.get("has_more", data.get("has_more", False)):
            break
        next_offset = view.get("next_offset", data.get("next_offset", offset + len(cells)))
        if isinstance(next_offset, bool) or not str(next_offset).isdigit():
            break
        next_offset = int(next_offset)
        if next_offset <= offset or next_offset > 100000:
            break
        offset = next_offset
    return rows
