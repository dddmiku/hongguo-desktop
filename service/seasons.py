"""Conservative, read-only season discovery with bounded successful-result caching.

The mobile detail response has ``is_multi_season``, ``related_album_id`` and
``season_index``. Search results are discovery candidates, never season links.
Only a shared official album can bypass title/cast matching; next-season jumps
still require the immediately following index. No media/account data is retained.
"""
from __future__ import annotations

from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import dataclass
import re
import threading
import time
import unicodedata


_ID = re.compile(r"[0-9]{8,24}\Z")
_NUMBER = r"(?:[0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3})"
_SUFFIX = re.compile(rf"(?:第\s*({_NUMBER})|(?<![0-9零〇一二两三四五六七八九十百千])({_NUMBER}))\s*(?:季|部)\Z")
_BRACKET = re.compile(r"\(([^()]*)\)\Z")
_DIGIT_SUFFIX = re.compile(r"(?<![0-9])([1-9][0-9]?)\Z")
_SPECIAL = re.compile(r"番外|合集|合辑|花絮|特辑|特别篇|总集篇|剪辑|精编|重制|新版|翻拍|剧场版|真人版|动漫版|漫剧版|AI版", re.I)
_CN = {char: index for index, char in enumerate("零一二三四五六七八九")}
_CN.update({"〇": 0, "两": 2})


class SeasonLookupError(RuntimeError):
    """Fixed diagnostic only; upstream bodies and exceptions are never copied."""


def _integer(value, default=0):
    if isinstance(value, bool):
        return default
    try:
        return max(0, int(value))
    except (TypeError, ValueError, OverflowError):
        return default


def _season_number(text):
    text = text.strip()
    if text.isascii() and text.isdigit():
        value = int(text)
    elif "十" in text:
        if text.count("十") != 1:
            return 0
        tens, units = text.split("十")
        if len(tens) > 1 or len(units) > 1 or (tens and tens not in _CN) or (units and units not in _CN):
            return 0
        value = (_CN[tens] if tens else 1) * 10 + (_CN[units] if units else 0)
    elif len(text) == 1 and text in _CN:
        value = _CN[text]
    else:
        return 0
    return value if 1 <= value <= 99 else 0


@dataclass(frozen=True)
class SeasonTitle:
    base: str
    index: int
    explicit: bool
    safe: bool


def parse_season_title(title) -> SeasonTitle:
    """Remove one terminal season marker, retaining all other title qualifiers."""
    text = unicodedata.normalize("NFKC", str(title or "")).strip()
    if not text or len(text) > 200 or _SPECIAL.search(text):
        return SeasonTitle(text, 1, False, False)
    end = len(text)
    bracket = _BRACKET.search(text)
    marker = bracket.group(1).strip() if bracket else text
    match = _SUFFIX.search(marker)
    if match and (not bracket or match.start() == 0):
        index = _season_number(match.group(1) or match.group(2))
        end = bracket.start() if bracket else match.start()
    elif bracket and re.fullmatch(_NUMBER, marker):
        index, end = _season_number(marker), bracket.start()
    elif not bracket and (match := _DIGIT_SUFFIX.search(text)):
        index, end = _season_number(match.group(1)), match.start()
    else:
        return SeasonTitle(text, 1, False, True)
    base = text[:end].rstrip(" \t-—_:：·")
    if not index or not base:
        return SeasonTitle(text, 1, False, False)
    return SeasonTitle(base, index, True, True)


def _base_key(value):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip().casefold()


def _actors(meta):
    source = meta.get("celebrities") or meta.get("actors") or []
    if not isinstance(source, list):
        return []
    names = []
    for actor in source[:20]:
        name = actor.get("nickname") or actor.get("演员") if isinstance(actor, dict) else actor
        if name:
            name = _base_key(str(name))
            if name not in names:
                names.append(name)
    return names


def _kind(meta):
    value = meta.get("content_type") or meta.get("genre") or meta.get("contentType")
    return str(value).strip().casefold() if value not in (None, "", 0, "0") else ""


def _same_kind(current, candidate, *, require_known):
    left, right = _kind(current), _kind(candidate)
    if require_known and (not left or not right):
        return False
    if left and right and left != right:
        return False
    # AI adaptations can share the broad content_type with live-action plays.
    left_ai, right_ai = current.get("ai_usage_type"), candidate.get("ai_usage_type")
    if left_ai is not None and right_ai is not None and str(left_ai) != str(right_ai):
        return False
    return True


def _same_cast(current, candidate):
    left, right = _actors(current)[:2], _actors(candidate)[:2]
    if not left and not right:
        # Castless animation is normal; live-action needs positive cast evidence.
        return _kind(current) in {"comic_series", "ai_series", "2", "3"}
    if not left or not right:
        return False
    return set(left) == set(right)


def _official(meta):
    album = str(meta.get("related_album_id") or "")
    index = _integer(meta.get("season_index"))
    # Some official detail responses omit the switch while retaining album/index.
    # An explicitly disabled switch must not become an official relation.
    enabled = "is_multi_season" not in meta or meta.get("is_multi_season") in (True, 1, "1", "true")
    return (album, index) if enabled and _ID.fullmatch(album) and index else None


def _needs_identity_detail(current, candidate):
    """Supplement only plausible identity omissions; a title never proves a link."""
    official = _official(current)
    if not official or _official(candidate) or not _same_kind(current, candidate, require_known=False):
        return False
    if ("is_multi_season" in candidate
            and candidate["is_multi_season"] not in (True, 1, "1", "true")):
        return False
    album = candidate.get("related_album_id") or ""
    if _ID.fullmatch(album):
        return album == official[0] and not candidate["season_index"]
    left, right = parse_season_title(current["title"]), parse_season_title(candidate["title"])
    return left.safe and right.safe and _base_key(left.base) == _base_key(right.base)


def _metadata(sid, raw, *, from_batch=False):
    """Whitelist structural identity fields from the raw mobile response."""
    if not isinstance(raw, dict) or not raw:
        raise SeasonLookupError("剧集季信息暂时不可用")
    episodes = [row for name in ("video_list", "video_list_unique")
                for row in (raw[name] if isinstance(raw.get(name), list) else []) if isinstance(row, dict)]
    indexes = {_integer(row.get("vid_index")) for row in episodes}
    indexes.discard(0)
    playable = {_integer(row.get("vid_index")) for row in episodes
                if str(row.get("vid") or row.get("video_id") or "").strip()}
    playable.discard(0)
    total = _integer(raw.get("total_episode")) or len(indexes)
    tags = raw.get("tags") or raw.get("category") or re.findall(r'"name"\s*:\s*"([^"]+)"', str(raw.get("category_schema") or ""))
    if isinstance(tags, str):
        tags = [part.strip() for part in tags.split("/") if part.strip()]
    actors = raw.get("actors") or raw.get("celebrities") or []
    actors = [str(actor.get("演员") or actor.get("nickname") or "") if isinstance(actor, dict)
              else str(actor) for actor in actors] if isinstance(actors, list) else []
    cover = str(raw.get("series_cover") or raw.get("cover") or raw.get("thumb_url") or "")
    series = {"id": sid, "title": str(raw.get("series_title") or raw.get("title") or "")[:200],
              "cover": cover if cover.startswith("https://") else "",
              "intro": str(raw.get("series_intro") or raw.get("intro") or "")[:2000],
              "totalEpisodes": total, "tags": [str(tag)[:80] for tag in tags[:12]] if isinstance(tags, list) else [],
              "actors": [actor for actor in actors if actor][:20], "score": str(raw.get("score") or "")[:20]}
    return {"id": sid, "title": str(raw.get("series_title") or raw.get("title") or "")[:200],
            "content_type": raw.get("content_type"), "genre": raw.get("genre"),
            "ai_usage_type": raw.get("ai_usage_type"),
            **({"is_multi_season": raw["is_multi_season"]} if "is_multi_season" in raw else {}),
            "related_album_id": str(raw.get("related_album_id") or ""),
            "season_index": _integer(raw.get("season_index")),
            "celebrities": [{"nickname": name} for name in _actors(raw)], "series": series,
            "first_episode": min(playable) if playable else None,
            # A batch may return only preview episode rows. Count them only after
            # a matched season has been read as a single full-series response.
            "total_complete": not from_batch or bool(_integer(raw.get("total_episode")))}


class SeasonResolver:
    """Read-only overview and next-season discovery share one candidate snapshot.

    Found results live for ten minutes, empty/ambiguous results for two minutes.
    Exceptions propagate through the injected provider read boundary and are
    never cached. A refresh explicitly bypasses successful cached resolutions.
    """
    def __init__(self, sdk, detail, read, *, capacity=128, ttl=600, empty_ttl=120, clock=time.monotonic):
        self.sdk, self.detail, self.read = sdk, detail, read
        self.capacity = max(1, min(256, int(capacity)))
        self.ttl = max(1, min(3600, float(ttl)))
        self.empty_ttl = max(1, min(self.ttl, float(empty_ttl)))
        self.clock = clock
        self.values = OrderedDict()
        self.running = set()
        self.condition = threading.Condition()

    def clear(self):
        with self.condition:
            self.values.clear()

    def resolve(self, series_id, *, refresh=False):
        return self._lookup(series_id, "resolve", "查找下一季", self._resolve, refresh)

    def overview(self, series_id, refresh=False):
        return self._lookup(series_id, "overview", "读取全部季", self._overview, refresh)

    def _lookup(self, series_id, operation, label, build, refresh):
        sid = str(series_id or "")
        if not _ID.fullmatch(sid):
            raise ValueError("剧集标识不正确")
        with self.condition:
            while sid in self.running:
                self.condition.wait(timeout=30)
            entry = self.values.get(sid)
            if not refresh and entry and entry[0] > self.clock():
                self.values.move_to_end(sid)
                if operation in entry[1]["results"]:
                    return deepcopy(entry[1]["results"][operation])
                bundle = deepcopy(entry[1])
                deadline = entry[0]
            else:
                bundle = None
                deadline = None
            self.running.add(sid)
        try:
            def load():
                nonlocal bundle
                if bundle is None:
                    bundle = self._collect(sid)
                return build(sid, bundle)
            result = self.read(label, load)
            bundle["results"][operation] = deepcopy(result)
            with self.condition:
                now = self.clock()
                for key in list(self.values):
                    if self.values[key][0] <= now:
                        self.values.pop(key)
                duration = self.ttl if bundle.get("complete", True) and any(
                    value["status"] == "found" for value in bundle["results"].values()) else self.empty_ttl
                expires = deadline if deadline is not None else now + duration
                if expires > now:
                    official = _official(bundle["current"])
                    if official and not bundle["ambiguous"]:
                        # A verified public album snapshot can be viewed from any
                        # member without searching and reading every season again.
                        for number, member in bundle["members"]:
                            if member["id"] == sid or (_official(member) or (None,))[0] != official[0]:
                                continue
                            # Cached public snapshots are copied before reading;
                            # aliases can share immutable members without storing
                            # the same large family once per season in memory.
                            alias = dict(bundle)
                            alias.update(current=member, index=number,
                                         safe=parse_season_title(member["title"]).safe, results={})
                            self.values[member["id"]] = (expires, alias)
                            self.values.move_to_end(member["id"])
                    self.values[sid] = (expires, deepcopy(bundle))
                    self.values.move_to_end(sid)
                while len(self.values) > self.capacity:
                    self.values.popitem(last=False)
            return result
        finally:
            with self.condition:
                self.running.discard(sid)
                self.condition.notify_all()

    def _details(self, ids):
        result = {}
        ids = list(dict.fromkeys(ids))
        for start in range(0, len(ids), 20):
            batch = ids[start:start + 20]
            raw = self.sdk.api("POST", "/novel/player/multi_video_detail/v1/",
                               body=self.sdk._episodes_body(",".join(batch)))
            data = raw.get("data") if isinstance(raw, dict) else None
            if not isinstance(data, dict):
                raise SeasonLookupError("剧集季信息暂时不可用")
            for sid in batch:
                entry = data.get(sid)
                video = entry.get("video_data") if isinstance(entry, dict) else None
                result[sid] = _metadata(sid, video, from_batch=len(batch) > 1)
        return result

    def _search(self, query):
        # The current title is already verified metadata. Search its main/base
        # title once and let _collect validate all candidates against the album.
        # Import here because public search reuses this module's title parser.
        from search import fallback_query
        discovery = fallback_query(query) or query
        # Question-and-subtitle titles behave like colon subtitles upstream.
        # A terminal grammatical particle can hide the related search family;
        # dropping it changes discovery only, never the official album check.
        split = re.split(r"[？?]", discovery, maxsplit=1)
        if len(split) == 2 and split[1].strip() and len(split[0].strip()) >= 3:
            discovery = split[0].strip()
            if discovery.endswith("的"):
                discovery = discovery[:-1]
        return self._search_query(discovery, family_base=query)

    def _search_query(self, query, *, family_base=""):
        from search import SearchRows
        results, seen = [], set()
        offset, passback, search_id = 0, "", ""
        cursors = {("0", "", "")}
        family = _base_key(parse_season_title(family_base).base) if family_base else ""
        matched_family, empty_family_pages = False, 0
        complete = True
        for _ in range(12):
            params = {"query": query, "tab_name": "feed", "search_source": "1", "offset": str(offset),
                      "count": "0", "use_correct": "false"}
            if passback:
                params["passback"] = passback
            if search_id:
                params["search_id"] = search_id
            try:
                raw = self.sdk.api("GET", "/reading/bookapi/search/tab/v", extra_query=params)
                tabs = raw.get("search_tabs") if isinstance(raw, dict) else None
                if not isinstance(tabs, list):
                    raise SeasonLookupError("下一季搜索结果暂时不可用")
                if not tabs:
                    break
                tab = tabs[0]
                rows = tab.get("data") if isinstance(tab, dict) else None
                if not isinstance(rows, list):
                    raise SeasonLookupError("下一季搜索结果暂时不可用")
            except Exception:
                if not results:
                    raise
                complete = False
                break
            family_in_page = 0
            for cell in rows:
                if not isinstance(cell, dict):
                    complete = False
                    continue
                try:
                    item = self.sdk._parse_search_cell(cell)
                except (TypeError, ValueError, AttributeError):
                    complete = False
                    continue
                if not item:
                    continue
                if family and _base_key(parse_season_title(item.get("title")).base) == family:
                    family_in_page += 1
                sid = str(item.get("series_id") or "")
                if not _ID.fullmatch(sid) or sid in seen:
                    continue
                seen.add(sid)
                results.append({"id": sid, "title": str(item.get("title") or "")[:200]})
                if len(results) == 128:
                    return SearchRows(results, complete=False)
            if not tab.get("has_more"):
                break
            matched_family = matched_family or family_in_page > 0
            empty_family_pages = 0 if family_in_page else empty_family_pages + 1
            if not rows or matched_family and empty_family_pages >= 2:
                complete = False
                break
            next_offset = tab.get("next_offset")
            next_passback = tab.get("passback") or passback
            next_search_id = tab.get("search_id") or search_id
            cursor = (str(next_offset), str(next_passback), str(next_search_id))
            if next_offset is None or cursor in cursors:
                if not results:
                    raise SeasonLookupError("下一季搜索分页暂时不可用")
                complete = False
                break
            cursors.add(cursor)
            offset, passback = next_offset, next_passback
            search_id = next_search_id
        else:
            complete = False
        return SearchRows(results, complete=complete)

    @staticmethod
    def _result(sid, index, status="none", *, next_series=None, next_index=None, source=None, first_episode=None):
        return {"seriesId": sid, "status": status, "season": index, "nextSeason": next_index,
                "next": next_series, "source": source, "firstEpisode": first_episode}

    def _collect(self, sid):
        current = self._details([sid])[sid]
        title = parse_season_title(current["title"])
        official = _official(current)
        index = official[1] if official else title.index
        bundle = {"current": current, "index": index, "safe": title.safe,
                  "source": "official" if official else "title", "members": [(index, current)],
                  "ambiguous": False, "details": {}, "results": {}, "complete": True}
        if not title.safe or not 1 <= len(title.base) <= 80:
            return bundle
        search = self._search(title.base)
        bundle["complete"] = getattr(search, "complete", True)
        discovered = [row for row in search if row["id"] != sid]
        if not official:
            discovered = [row for row in discovered if (parsed := parse_season_title(row["title"])).safe
                          and _base_key(parsed.base) == _base_key(title.base)]
        if not discovered:
            return bundle
        candidates = self._details([row["id"] for row in discovered])
        def match(candidate):
            if _needs_identity_detail(current, candidate):
                candidate = self._details([candidate["id"]])[candidate["id"]]
            parsed = parse_season_title(candidate["title"])
            if not parsed.safe or not _same_kind(current, candidate, require_known=not official):
                return None
            if official:
                link = _official(candidate)
                if not link or link[0] != official[0]:
                    return None
                if not candidate["total_complete"] or not candidate["series"]["totalEpisodes"]:
                    candidate = self._details([candidate["id"]])[candidate["id"]]
                    link = _official(candidate)
                    if (not link or link[0] != official[0]
                            or not parse_season_title(candidate["title"]).safe
                            or not _same_kind(current, candidate, require_known=False)):
                        return None
                candidate_index = link[1]
            else:
                if (_base_key(parsed.base) != _base_key(title.base) or not _same_cast(current, candidate)):
                    return None
                # A separately numbered official first season is a remake, not part two.
                if candidate["season_index"] and candidate["season_index"] != parsed.index:
                    return None
                if not candidate["total_complete"]:
                    candidate = self._details([candidate["id"]])[candidate["id"]]
                    parsed = parse_season_title(candidate["title"])
                    if (not parsed.safe or not _same_kind(current, candidate, require_known=True)
                            or _base_key(parsed.base) != _base_key(title.base)
                            or not _same_cast(current, candidate)
                            or candidate["season_index"] and candidate["season_index"] != parsed.index):
                        return None
                candidate_index = parsed.index
            return candidate_index, candidate
        if len(candidates) > 8:
            def isolated_match(candidate):
                try:
                    return match(candidate), True
                except Exception:
                    # One unavailable season in a large public family must not
                    # erase other verified members or imply that the gap is gone.
                    return None, False
            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="season-detail") as pool:
                checked = list(pool.map(isolated_match, candidates.values()))
            members = [member for member, _ in checked]
            if any(not ok for _, ok in checked):
                bundle["complete"] = False
        else:
            members = [match(candidate) for candidate in candidates.values()]
        bundle["members"].extend(member for member in members if member is not None)
        bundle["members"].sort(key=lambda item: item[0])
        indexes = [number for number, _ in bundle["members"]]
        bundle["ambiguous"] = len(indexes) != len(set(indexes))
        return bundle

    def _validated_detail(self, target, bundle):
        if target in bundle["details"]:
            return bundle["details"][target]
        member = next((meta for _, meta in bundle["members"] if meta["id"] == target), None)
        if member is not None and member["first_episode"] and member["series"]["totalEpisodes"]:
            result = {"series": deepcopy(member["series"]), "indexes": [member["first_episode"]]}
            bundle["details"][target] = result
            return result
        try:
            detail = self.detail(target)
        except Exception as error:
            if getattr(error, "code", "") == "SERIES_NOT_FOUND":
                return None
            raise
        episodes = detail.get("episodes") if isinstance(detail, dict) else None
        series = detail.get("series") if isinstance(detail, dict) else None
        indexes = [_integer(row.get("index")) for row in episodes if isinstance(row, dict)] if isinstance(episodes, list) else []
        indexes = [number for number in indexes if number]
        if not isinstance(series, dict) or str(series.get("id")) != target or not indexes:
            return None
        result = {"series": deepcopy(series), "indexes": indexes}
        bundle["details"][target] = result
        return result

    def _series(self, member, bundle):
        series = deepcopy(member["series"])
        if not series["totalEpisodes"]:
            detail = self._validated_detail(member["id"], bundle)
            if detail is None:
                raise SeasonLookupError("剧集季信息暂时不可用")
            series = {**series, **detail["series"], "totalEpisodes": len(set(detail["indexes"]))}
        return series

    def _resolve(self, sid, bundle):
        index = bundle["index"]
        if bundle["ambiguous"]:
            return self._result(sid, index, "ambiguous")
        matches = [member for number, member in bundle["members"] if number == index + 1]
        if not matches:
            return self._result(sid, index)
        member = matches[0]
        detail = self._validated_detail(member["id"], bundle)
        if detail is None:
            return self._result(sid, index)
        series = {**member["series"], **detail["series"],
                  "totalEpisodes": member["series"]["totalEpisodes"] or len(set(detail["indexes"]))}
        return self._result(sid, index, "found", next_series=series, next_index=index + 1,
                            source=bundle["source"], first_episode=min(detail["indexes"]))

    def _overview(self, sid, bundle):
        members = bundle["members"]
        if bundle["ambiguous"]:
            members = [(bundle["index"], bundle["current"])]
        status = "ambiguous" if bundle["ambiguous"] else "found" if len(members) > 1 else "single"
        return {"seriesId": sid, "status": status,
                "source": bundle["source"] if status != "single" else None,
                "currentSeason": bundle["index"] if bundle["safe"] else None,
                "complete": bundle.get("complete", True),
                **({"warning": "关联季仍可能有遗漏，已保留找到的作品，可刷新继续核对"}
                   if not bundle.get("complete", True) else {}),
                "seasons": [{"season": number, "series": self._series(member, bundle)}
                            for number, member in members] if bundle["safe"] else []}
