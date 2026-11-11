"""Season continuity contracts; public metadata only, no account or media RPCs."""
from copy import deepcopy
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from seasons import SeasonLookupError, SeasonResolver, parse_season_title


CURRENT = "12345678"
NEXT = "23456789"
THIRD = "34567890"
OTHER = "45678901"
ALBUM = "987654321"


def metadata(sid, title, *, season=0, album="", actors=("甲", "乙"), kind=1, **extras):
    return {"series_id": sid, "series_title": title, "content_type": kind,
            "season_index": season, "related_album_id": album, "is_multi_season": bool(album),
            "celebrities": [{"nickname": actor} for actor in actors], **extras}


class FixtureSDK:
    def __init__(self, values):
        self.values = {row["series_id"]: row for row in values}
        self.api = Mock(side_effect=self._api)
        self.search_rows = list(self.values.values())

    @staticmethod
    def _episodes_body(ids):
        return {"series_id": ids}

    @staticmethod
    def _parse_search_cell(row):
        return {"series_id": row["series_id"], "title": row["series_title"], "episode_cnt": 10}

    def _api(self, method, path, **kwargs):
        if method == "GET":
            return {"search_tabs": [{"tab_type": 29, "data": deepcopy(self.search_rows), "has_more": False}]}
        ids = kwargs["body"]["series_id"].split(",")
        return {"data": {sid: {"video_data": deepcopy(self.values[sid])} for sid in ids}}


class SeasonTests(unittest.TestCase):
    def resolver(self, values, **kwargs):
        sdk = FixtureSDK(values)
        detail = Mock(side_effect=lambda sid: {"series": {"id": sid, "title": sdk.values[sid]["series_title"]},
                                             "episodes": [{"index": 2}, {"index": 1}]})
        read = Mock(side_effect=lambda label, loader: loader())
        resolver = SeasonResolver(sdk, detail, read, **kwargs)
        return resolver, sdk, detail

    def large_question_family(self, *, recommendation_tail=0, **kwargs):
        title = "谁说没灵根不能修仙的？之无灵证道"
        ids = [str(12000000 + number) for number in range(1, 47)]
        rows = [metadata(sid, title + (str(number) + "季" if number > 1 else ""),
                         season=number, album=ALBUM, total_episode=number + 77,
                         video_list=[{"vid_index": 1, "vid": str(22000000 + number)}])
                for number, sid in enumerate(ids, 1)]
        extras = [metadata(str(32000000 + number), "无关推荐" + str(number), total_episode=8)
                  for number in range(recommendation_tail)]
        resolver, sdk, detail = self.resolver([*rows, *extras], **kwargs)
        def pages(method, path, **options):
            if method != "GET":
                return sdk._api(method, path, **options)
            params = options["extra_query"]
            if params["query"] != "谁说没灵根不能修仙":
                return {"search_tabs": [{"tab_type": 29, "data": [rows[0], rows[-2]], "has_more": False}]}
            offset = int(params["offset"])
            size = 6 if offset == 0 else 10
            candidates = [*rows, *extras]
            return {"search_tabs": [{"tab_type": 29, "data": deepcopy(candidates[offset:offset + size]),
                    "has_more": offset + size < len(candidates), "next_offset": offset + size}]}
        sdk.api.side_effect = pages
        return resolver, sdk, detail, ids

    def test_question_subtitle_family_discovers_all_46_seasons_beyond_the_old_40_cap(self):
        resolver, sdk, detail, ids = self.large_question_family()
        result = resolver.overview(ids[0])
        self.assertEqual([row["season"] for row in result["seasons"]], list(range(1, 47)))
        self.assertTrue(result["complete"])
        self.assertEqual(result["seasons"][0]["series"]["totalEpisodes"], 78)
        queries = [call.kwargs["extra_query"]["query"] for call in sdk.api.call_args_list if call.args[0] == "GET"]
        self.assertEqual(set(queries), {"谁说没灵根不能修仙"})
        self.assertGreater(len(queries), 4)
        detail.assert_not_called()

    def test_real_drama_tab_returns_all_official_seasons_not_comprehensive_recommendations(self):
        title = '无敌财神！我觉醒了唯一隐藏职业'
        ids = [str(12000000 + index) for index in range(1, 7)]
        rows = [metadata(sid, title + (str(index) + '季' if index > 1 else ''), season=index,
                         album=ALBUM, total_episode=index + 76) for index, sid in enumerate(ids, 1)]
        resolver, sdk, _ = self.resolver(rows)
        def selected(method, path, **options):
            if method == 'GET':
                return {'selected_tab_idx': 1, 'search_tabs': [
                    {'tab_type': 11, 'title': '综合', 'data': [rows[0]], 'has_more': False},
                    {'tab_type': 29, 'title': '剧集', 'data': rows, 'has_more': False}]}
            return sdk._api(method, path, **options)
        sdk.api.side_effect = selected
        overview = resolver.overview(ids[0])
        self.assertEqual([row['season'] for row in overview['seasons']], list(range(1, 7)))
        calls = [call for call in sdk.api.call_args_list if call.args[0] == 'GET']
        self.assertEqual(calls[0].kwargs['extra_query']['tab_type'], '29')

    def web_family(self):
        title = '无敌财神！我觉醒了唯一隐藏职业'
        ids = [str(12000000 + index) for index in range(1, 7)]
        rows = [metadata(sid, title + (str(index) + '季' if index > 1 else ''), season=index,
                         album=ALBUM, total_episode=index + 76,
                         video_list=[{'vid_index':1, 'vid':str(22000000+index)}]) for index, sid in enumerate(ids, 1)]
        fallback = Mock(return_value=[{'series_id':row['series_id'], 'title':row['series_title']} for row in rows])
        resolver, sdk, detail = self.resolver(rows, search_fallback=fallback)
        return resolver, sdk, detail, fallback, rows, ids

    def test_web_candidates_fill_only_current_mobile_discovery_and_keep_official_links(self):
        resolver, sdk, detail, fallback, rows, ids = self.web_family()
        sdk.search_rows = rows[:1]
        overview = resolver.overview(ids[0])
        self.assertEqual([row['season'] for row in overview['seasons']], list(range(1, 7)))
        self.assertFalse(overview['complete'])
        self.assertEqual(overview['source'], 'official')
        self.assertEqual(resolver.resolve(ids[0])['next']['id'], ids[1])
        fallback.assert_called_once_with(parse_season_title(rows[0]['series_title']).base)
        detail.assert_not_called()

    def test_web_candidates_can_restore_mobile_search_outage_without_claiming_complete(self):
        resolver, sdk, _, fallback, rows, ids = self.web_family()
        def unavailable(method, path, **options):
            if method == 'GET':raise SeasonLookupError('固定手机搜索失败')
            return sdk._api(method, path, **options)
        sdk.api.side_effect = unavailable
        overview = resolver.overview(ids[0])
        self.assertEqual(len(overview['seasons']), 6)
        self.assertFalse(overview['complete'])
        self.assertEqual(overview['source'], 'official')
        fallback.assert_called_once()

    def test_web_candidates_fill_gaps_when_mobile_discovery_only_has_first_and_sixth(self):
        resolver, sdk, _, fallback, rows, ids = self.web_family()
        sdk.search_rows = [rows[0], rows[-1]]
        overview = resolver.overview(ids[0])
        self.assertEqual([row['season'] for row in overview['seasons']], list(range(1, 7)))
        self.assertFalse(overview['complete'])
        fallback.assert_called_once()

    def test_web_failure_keeps_existing_mobile_rows_as_partial_and_refresh_is_retryable(self):
        resolver, sdk, _, fallback, rows, ids = self.web_family()
        sdk.search_rows = rows[:2]
        fallback.side_effect = SeasonLookupError('固定官网失败')
        # Force an incomplete discovery so both channels are necessary.
        def partial(method, path, **options):
            if method == 'GET':
                offset = options['extra_query']['offset']
                if offset != '0':raise SeasonLookupError('固定后页失败')
                return {'search_tabs':[{'tab_type':29, 'data':rows[:2], 'has_more':True,'next_offset':2}]}
            return sdk._api(method, path, **options)
        sdk.api.side_effect = partial
        overview = resolver.overview(ids[0])
        self.assertEqual([row['season'] for row in overview['seasons']], [1, 2])
        self.assertFalse(overview['complete'])
        self.assertLessEqual(resolver.values[ids[0]][0] - resolver.clock(), resolver.empty_ttl)
        fallback.side_effect = None
        self.assertEqual(len(resolver.overview(ids[0], refresh=True)['seasons']), 6)

    def test_both_discovery_sources_failing_preserves_original_error_and_has_no_empty_cache(self):
        resolver, sdk, _, fallback, rows, ids = self.web_family()
        original = SeasonLookupError('固定手机原始失败')
        def unavailable(method, path, **options):
            if method == 'GET':raise original
            return sdk._api(method, path, **options)
        sdk.api.side_effect = unavailable
        fallback.side_effect = RuntimeError('固定官网失败')
        with self.assertRaises(SeasonLookupError) as caught:resolver.overview(ids[0])
        self.assertIs(caught.exception, original)
        self.assertFalse(resolver.values)

    def test_web_candidates_still_reject_other_official_album_and_invalid_entries(self):
        resolver, sdk, _, fallback, rows, ids = self.web_family()
        sdk.search_rows = rows[:1]
        sdk.values[OTHER] = metadata(OTHER, rows[0]['series_title'] + '7季', season=7,
                                     album='111111111', total_episode=20)
        fallback.return_value.extend([{'series_id':OTHER, 'title':sdk.values[OTHER]['series_title']},
                                       {'series_id':'invalid', 'title':'无效'}, 'invalid'])
        overview = resolver.overview(ids[0])
        self.assertEqual([row['season'] for row in overview['seasons']], list(range(1, 7)))
        self.assertNotIn(OTHER, [row['series']['id'] for row in overview['seasons']])

    def test_verified_mobile_family_does_not_need_optional_website_reads(self):
        resolver, sdk, _, fallback, rows, ids = self.web_family()
        overview = resolver.overview(ids[0])
        self.assertEqual(len(overview['seasons']), 6)
        self.assertTrue(overview['complete'])
        fallback.assert_not_called()

    def test_official_family_snapshot_is_reused_from_middle_season_without_requery(self):
        resolver, sdk, _, ids = self.large_question_family()
        resolver.overview(ids[0])
        calls = sdk.api.call_count
        result = resolver.overview(ids[44])
        self.assertEqual(result["currentSeason"], 45)
        self.assertEqual([row["season"] for row in result["seasons"]], list(range(1, 47)))
        self.assertEqual(resolver.resolve(ids[44])["next"]["id"], ids[45])
        self.assertEqual(sdk.api.call_count, calls)

    def test_recommendation_tail_stays_partial_with_short_cache_and_refresh(self):
        now = [100.0]
        resolver, sdk, _, ids = self.large_question_family(recommendation_tail=100,
                         ttl=600, empty_ttl=120, clock=lambda: now[0])
        result = resolver.overview(ids[0])
        self.assertEqual(len(result["seasons"]), 46)
        self.assertFalse(result["complete"])
        self.assertIn("warning", result)
        self.assertLessEqual(resolver.values[ids[0]][0] - now[0], 120)
        queries = [call for call in sdk.api.call_args_list if call.args[0] == "GET"]
        self.assertLess(len(queries), 12)
        count = sdk.api.call_count
        middle = resolver.overview(ids[44])
        self.assertFalse(middle["complete"])
        self.assertEqual(sdk.api.call_count, count)
        resolver.overview(ids[0], refresh=True)
        self.assertGreater(sdk.api.call_count, count)

    def test_large_family_missing_totals_uses_at_most_two_single_series_readers(self):
        resolver, sdk, _, ids = self.large_question_family()
        original = sdk.api.side_effect
        guard = threading.Lock()
        active, peak = [0], [0]
        def metadata_reads(method, path, **options):
            series = options.get("body", {}).get("series_id", "")
            if method == "POST" and "," in series:
                result = original(method, path, **options)
                for entry in result["data"].values():
                    entry["video_data"].pop("total_episode")
                return result
            if method == "POST" and series != ids[0]:
                with guard:
                    active[0] += 1
                    peak[0] = max(peak[0], active[0])
                try:
                    time.sleep(.005)
                    return original(method, path, **options)
                finally:
                    with guard:
                        active[0] -= 1
            return original(method, path, **options)
        sdk.api.side_effect = metadata_reads
        self.assertEqual(len(resolver.overview(ids[0])["seasons"]), 46)
        self.assertEqual(peak[0], 2)
        self.assertEqual(active[0], 0)

    def test_large_family_one_metadata_failure_keeps_verified_members_without_skipping_missing_next(self):
        resolver, sdk, _, ids = self.large_question_family()
        original = sdk.api.side_effect
        failing = [True]
        def unavailable_member(method, path, **options):
            series = options.get("body", {}).get("series_id", "")
            if method == "POST" and series == ids[1] and failing[0]:
                raise SeasonLookupError("固定第二季补读失败")
            result = original(method, path, **options)
            if method == "POST" and "," in series:
                for entry in result["data"].values():
                    entry["video_data"].pop("total_episode")
            return result
        sdk.api.side_effect = unavailable_member
        overview = resolver.overview(ids[0])
        self.assertEqual(len(overview["seasons"]), 45)
        self.assertFalse(overview["complete"])
        self.assertNotIn(2, [row["season"] for row in overview["seasons"]])
        following = resolver.resolve(ids[0])
        self.assertEqual(following["status"], "none")
        self.assertIsNone(following["next"])
        failing[0] = False
        self.assertEqual(len(resolver.overview(ids[0], refresh=True)["seasons"]), 46)

    def test_later_discovery_failure_keeps_known_seasons_partial_and_does_not_invent_a_gap(self):
        rows = [metadata(CURRENT, "春风", season=1, album=ALBUM, total_episode=12),
                metadata(THIRD, "春风第三季", season=3, album=ALBUM, total_episode=31)]
        resolver, sdk, _ = self.resolver(rows)
        reads = [0]
        def interrupted(method, path, **options):
            if method == "GET":
                reads[0] += 1
                if reads[0] > 1:
                    raise SeasonLookupError("固定后页失败")
                return {"search_tabs": [{"tab_type": 29, "data": deepcopy(rows), "has_more": True, "next_offset": 2}]}
            return sdk._api(method, path, **options)
        sdk.api.side_effect = interrupted
        overview = resolver.overview(CURRENT)
        self.assertEqual([row["season"] for row in overview["seasons"]], [1, 3])
        self.assertFalse(overview["complete"])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")
        self.assertIsNone(resolver.resolve(CURRENT)["next"])
        sdk.api.side_effect = sdk._api
        self.assertTrue(resolver.overview(CURRENT, refresh=True)["complete"])

    def test_discovery_candidates_remain_bounded_and_a_cap_is_not_complete(self):
        resolver, sdk, _, _ = self.large_question_family()
        many = [metadata(str(42000000 + number), "春风第二季", total_episode=8) for number in range(200)]
        sdk.api.side_effect = lambda *args, **options: {"search_tabs": [{"tab_type": 29, "data": many, "has_more": True,
                                                                       "next_offset": 200}]}
        candidates = resolver._search_query("春风", family_base="春风")
        self.assertEqual(len(candidates), 128)
        self.assertFalse(candidates.complete)
        self.assertEqual(sdk.api.call_count, 1)

    def test_chinese_numeric_and_bracket_markers(self):
        for first, second in (("长相思第一季", "长相思第二季"), ("长相思第1季", "长相思第2季"),
                              ("长相思（第一季）", "长相思（第二季）"), ("长相思(1)", "长相思(2)"),
                              ("长相思1", "长相思2"), ("长相思 一季", "长相思 二季")):
            with self.subTest(first=first, second=second):
                resolver, _, _ = self.resolver([metadata(CURRENT, first), metadata(NEXT, second)])
                result = resolver.resolve(CURRENT)
                self.assertEqual((result["status"], result["next"]["id"], result["nextSeason"]), ("found", NEXT, 2))
                self.assertEqual(result["source"], "title")

    def test_unnumbered_first_season_to_explicit_second(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
        result = resolver.resolve(CURRENT)
        self.assertEqual((result["season"], result["nextSeason"], result["firstEpisode"]), (1, 2, 1))

    def test_subtitle_search_uses_one_main_title_query_and_lists_all_eight_official_seasons(self):
        title = "觉醒伪神：神明弃我我自为神"
        ids = [CURRENT, *[str(int(CURRENT) + index) for index in range(1, 8)]]
        rows = [metadata(sid, title + (str(index) if index > 1 else ""), season=index, album=ALBUM,
                         total_episode=index * 11, video_list=[{"vid_index": 1, "vid": "99999999"}])
                for index, sid in enumerate(ids, 1)]
        resolver, sdk, detail = self.resolver(rows)
        def search(method, path, **kwargs):
            if method == "GET":
                query = kwargs["extra_query"]["query"]
                candidates = [rows[0], rows[-1], *rows[1:-1]] if query == "觉醒伪神" else [rows[0]]
                return {"search_tabs": [{"tab_type": 29, "data": deepcopy(candidates), "has_more": False}]}
            return sdk._api(method, path, **kwargs)
        sdk.api.side_effect = search
        result = resolver.overview(CURRENT)
        self.assertEqual(result["status"], "found")
        self.assertEqual([row["series"]["id"] for row in result["seasons"]], ids)
        self.assertEqual([row["series"]["totalEpisodes"] for row in result["seasons"]],
                         [index * 11 for index in range(1, 9)])
        calls = [call for call in sdk.api.call_args_list if call.args[0] == "GET"]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0].kwargs["extra_query"]["query"], "觉醒伪神")
        self.assertEqual(calls[0].kwargs["extra_query"]["use_correct"], "false")
        count = sdk.api.call_count
        self.assertEqual(resolver.resolve(CURRENT)["next"]["id"], ids[1])
        self.assertEqual(sdk.api.call_count, count)
        detail.assert_not_called()

    def test_main_title_discovery_keeps_renamed_official_album_member(self):
        resolver, sdk, _ = self.resolver([
            metadata(CURRENT, "春风：第一段故事", season=1, album=ALBUM),
            metadata(NEXT, "夏雨：改名后续季", season=2, album=ALBUM),
            metadata(OTHER, "春风：第一段故事2", season=2, album="123456789")])
        result = resolver.overview(CURRENT)
        self.assertEqual(result["source"], "official")
        self.assertEqual([row["series"]["id"] for row in result["seasons"]], [CURRENT, NEXT])
        calls = [call for call in sdk.api.call_args_list if call.args[0] == "GET"]
        self.assertEqual(calls[0].kwargs["extra_query"]["query"], "春风")

    def test_main_title_search_failure_is_not_cached_as_single_season(self):
        resolver, sdk, _ = self.resolver([
            metadata(CURRENT, "春风：第一段故事", season=1, album=ALBUM),
            metadata(NEXT, "春风：第一段故事2", season=2, album=ALBUM)])
        attempts = [0]
        def search(method, path, **kwargs):
            if method == "GET":
                attempts[0] += 1
                if attempts[0] == 1:
                    raise SeasonLookupError("固定上游失败夹具")
            return sdk._api(method, path, **kwargs)
        sdk.api.side_effect = search
        with self.assertRaises(SeasonLookupError):
            resolver.overview(CURRENT)
        self.assertFalse(resolver.values)
        self.assertEqual(resolver.overview(CURRENT)["status"], "found")

    def test_one_two_three_are_sorted_by_season_not_search_order(self):
        resolver, _, _ = self.resolver([metadata(THIRD, "春风第三季"), metadata(NEXT, "春风第二季"),
                                       metadata(CURRENT, "春风第一季")])
        self.assertEqual(resolver.resolve(CURRENT)["next"]["id"], NEXT)
        self.assertEqual(resolver.resolve(NEXT)["next"]["id"], THIRD)
        self.assertEqual(resolver.resolve(THIRD)["status"], "none")

    def test_does_not_skip_missing_second_season(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风第一季"), metadata(THIRD, "春风第三季")])
        self.assertIsNone(resolver.resolve(CURRENT)["next"])

    def test_two_equally_valid_second_seasons_are_ambiguous(self):
        resolver, _, detail = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季"),
                                            metadata(OTHER, "春风2")])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "ambiguous")
        detail.assert_not_called()

    def test_no_fuzzy_matching(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风十里第二季")])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_different_cast_does_not_match_by_title(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季", actors=("丙", "丁"))])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_missing_live_action_cast_is_insufficient(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风", actors=()), metadata(NEXT, "春风第二季", actors=())])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_castless_comics_can_match_with_same_type(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风", kind=2, actors=()),
                                       metadata(NEXT, "春风第二季", kind=2, actors=())])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "found")

    def test_cross_type_and_ai_adaptation_do_not_jump(self):
        for extras in ({"kind": 2}, {"ai_usage_type": 1}):
            with self.subTest(extras=extras):
                resolver, _, _ = self.resolver([metadata(CURRENT, "春风", ai_usage_type=0),
                                               metadata(NEXT, "春风第二季", **extras)])
                self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_specials_remakes_and_compilations_are_excluded(self):
        for qualifier in ("番外", "合集", "新版", "重制", "翻拍", "花絮", "特别篇", "真人版"):
            with self.subTest(qualifier=qualifier):
                resolver, _, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风" + qualifier + "第二季")])
                self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_official_album_precedes_titles_and_cast(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风", season=1, album=ALBUM),
                                       metadata(NEXT, "夏雨", season=2, album=ALBUM, actors=("丙", "丁")),
                                       metadata(OTHER, "春风第二季", season=2, album="123456789")])
        result = resolver.resolve(CURRENT)
        self.assertEqual((result["source"], result["next"]["id"]), ("official", NEXT))

    def test_official_album_rejects_wrong_index_and_other_album(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风", season=1, album=ALBUM),
                                       metadata(NEXT, "春风第二季", season=2, album="123456789"),
                                       metadata(THIRD, "春风第三季", season=3, album=ALBUM)])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_official_relation_still_excludes_specials_and_cross_type(self):
        for title, kind in (("春风番外第二季", 1), ("春风第二季", 2)):
            resolver, _, _ = self.resolver([metadata(CURRENT, "春风", season=1, album=ALBUM),
                                           metadata(NEXT, title, season=2, album=ALBUM, kind=kind)])
            self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_numbered_remake_official_first_season_cannot_be_title_fallback(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风2", season=1, album=ALBUM)])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_year_and_nonseason_brackets_are_retained(self):
        for title in ("春风2024", "春风2024季", "春风第一百季", "春风（张三版）", "春风之二"):
            parsed = parse_season_title(title)
            self.assertFalse(parsed.explicit)
            self.assertEqual(parsed.base, title.replace("（", "(").replace("）", ")"))
        self.assertEqual(parse_season_title("春风第二十二季").index, 22)

    def test_unknown_content_type_cannot_use_title_fallback(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风", kind=None), metadata(NEXT, "春风第二季", kind=None)])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_duplicate_official_next_index_is_ambiguous(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风", season=1, album=ALBUM),
                                       metadata(NEXT, "夏雨", season=2, album=ALBUM),
                                       metadata(OTHER, "秋露", season=2, album=ALBUM)])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "ambiguous")

    def test_metadata_missing_is_failure_not_cached_absence(self):
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
        sdk.api.side_effect = lambda *args, **kwargs: {"data": {}}
        with self.assertRaises(SeasonLookupError):
            resolver.resolve(CURRENT)
        self.assertFalse(resolver.values)

    def test_search_pagination_stall_keeps_partial_information_without_complete_cache(self):
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风")])
        def stuck(method, path, **kwargs):
            if method == "GET":
                return {"search_tabs": [{"tab_type": 29, "data": sdk.search_rows, "has_more": True, "next_offset": 0}]}
            return sdk._api(method, path, **kwargs)
        sdk.api.side_effect = stuck
        result = resolver.overview(CURRENT)
        self.assertFalse(result["complete"])
        self.assertEqual([row["season"] for row in result["seasons"]], [1])
        self.assertLessEqual(resolver.values[CURRENT][0] - resolver.clock(), resolver.empty_ttl)
        self.assertFalse(resolver.values[CURRENT][1]["complete"])
        sdk.api.side_effect = sdk._api
        self.assertTrue(resolver.overview(CURRENT, refresh=True)["complete"])

    def test_failure_is_not_cached_and_retry_can_recover(self):
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
        sdk.api.side_effect = RuntimeError("固定失败夹具")
        with self.assertRaises(RuntimeError):
            resolver.resolve(CURRENT)
        self.assertFalse(resolver.values)
        sdk.api.side_effect = sdk._api
        self.assertEqual(resolver.resolve(CURRENT)["status"], "found")

    def test_detail_failure_is_not_cached(self):
        resolver, _, detail = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
        detail.side_effect = RuntimeError("固定失败夹具")
        with self.assertRaises(RuntimeError):
            resolver.resolve(CURRENT)
        self.assertFalse(resolver.values)

    def test_malformed_search_is_failure_not_no_next(self):
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风")])
        def malformed(method, path, **kwargs):
            return {} if method == "GET" else sdk._api(method, path, **kwargs)
        sdk.api.side_effect = malformed
        with self.assertRaises(SeasonLookupError):
            resolver.resolve(CURRENT)
        self.assertFalse(resolver.values)

    def test_nonplayable_next_is_not_returned(self):
        resolver, _, detail = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
        detail.return_value = {"series": {"id": NEXT}, "episodes": []}
        detail.side_effect = None
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_success_cache_expires_refreshes_and_cannot_be_mutated_by_caller(self):
        now = [100.0]
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")],
                                       clock=lambda: now[0], ttl=10)
        first = resolver.resolve(CURRENT)
        count = sdk.api.call_count
        first["next"]["id"] = OTHER
        self.assertEqual(resolver.resolve(CURRENT)["next"]["id"], NEXT)
        self.assertEqual(sdk.api.call_count, count)
        now[0] += 11
        self.assertEqual(resolver.resolve(CURRENT)["status"], "found")
        self.assertGreater(sdk.api.call_count, count)
        count = sdk.api.call_count
        resolver.resolve(CURRENT, refresh=True)
        self.assertGreater(sdk.api.call_count, count)

    def test_empty_cache_has_short_ttl_and_capacity_is_bounded(self):
        now = [100.0]
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "夏雨")],
                                       clock=lambda: now[0], capacity=1, ttl=30, empty_ttl=2)
        resolver.resolve(CURRENT)
        count = sdk.api.call_count
        resolver.resolve(CURRENT)
        self.assertEqual(sdk.api.call_count, count)
        now[0] += 3
        resolver.resolve(CURRENT)
        self.assertGreater(sdk.api.call_count, count)
        resolver.resolve(NEXT)
        self.assertEqual(list(resolver.values), [NEXT])

    def test_parallel_lookups_share_one_fetch(self):
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
        started, release = threading.Event(), threading.Event()
        original = sdk._api
        def delayed(method, path, **kwargs):
            if not started.is_set():
                started.set()
                release.wait(timeout=5)
            return original(method, path, **kwargs)
        sdk.api.side_effect = delayed
        results = []
        first = threading.Thread(target=lambda: results.append(resolver.resolve(CURRENT)))
        second = threading.Thread(target=lambda: results.append(resolver.resolve(CURRENT)))
        first.start()
        self.assertTrue(started.wait(timeout=3))
        second.start()
        release.set()
        first.join(timeout=5)
        second.join(timeout=5)
        self.assertEqual(len(results), 2)
        self.assertEqual(sdk.api.call_count, 3)

    def test_overview_lists_all_official_seasons_in_order_with_real_totals(self):
        resolver, _, detail = self.resolver([
            metadata(THIRD, "秋露", season=3, album=ALBUM, total_episode="31"),
            metadata(NEXT, "夏雨", season=2, album=ALBUM, total_episode=22, episode_cnt=3),
            metadata(CURRENT, "春风", season=1, album=ALBUM, total_episode=12)])
        result = resolver.overview(NEXT)
        self.assertEqual((result["seriesId"], result["status"], result["source"], result["currentSeason"]),
                         (NEXT, "found", "official", 2))
        self.assertEqual([(row["season"], row["series"]["id"], row["series"]["totalEpisodes"])
                          for row in result["seasons"]], [(1, CURRENT, 12), (2, NEXT, 22), (3, THIRD, 31)])
        detail.assert_not_called()

    def test_overview_from_second_finds_unnumbered_first_and_third(self):
        resolver, _, _ = self.resolver([metadata(THIRD, "春风第三季"), metadata(NEXT, "春风第二季"),
                                       metadata(CURRENT, "春风")])
        result = resolver.overview(NEXT)
        self.assertEqual((result["status"], result["source"], result["currentSeason"]), ("found", "title", 2))
        self.assertEqual([row["season"] for row in result["seasons"]], [1, 2, 3])
        self.assertEqual([row["series"]["totalEpisodes"] for row in result["seasons"]], [2, 2, 2])

    def test_overview_can_show_later_season_without_resolve_skipping_missing_season(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风第一季"), metadata(THIRD, "春风第三季")])
        self.assertEqual([row["season"] for row in resolver.overview(CURRENT)["seasons"]], [1, 3])
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")

    def test_overview_title_fallback_rejects_cross_type_cast_and_remake(self):
        for extras in ({"kind": 2}, {"actors": ("丙", "丁")}, {"season": 1, "album": ALBUM}):
            resolver, _, _ = self.resolver([metadata(CURRENT, "春风"),
                                           metadata(NEXT, "春风第二季", **extras)])
            result = resolver.overview(CURRENT)
            self.assertEqual(result["status"], "single")
            self.assertEqual([row["series"]["id"] for row in result["seasons"]], [CURRENT])

    def test_overview_official_duplicates_are_ambiguous_without_guessing(self):
        resolver, _, _ = self.resolver([metadata(CURRENT, "春风", season=1, album=ALBUM),
                                       metadata(NEXT, "夏雨", season=2, album=ALBUM),
                                       metadata(OTHER, "秋露", season=2, album=ALBUM)])
        result = resolver.overview(CURRENT)
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual([row["series"]["id"] for row in result["seasons"]], [CURRENT])

    def test_overview_title_duplicates_at_current_or_later_season_are_ambiguous(self):
        for title in ("春风第一季", "春风2"):
            resolver, _, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季"),
                                           metadata(OTHER, title)])
            self.assertEqual(resolver.overview(CURRENT)["status"], "ambiguous")

    def test_overview_resolve_share_metadata_search_and_validated_detail(self):
        for first_operation in ("overview", "resolve"):
            resolver, sdk, detail = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
            getattr(resolver, first_operation)(CURRENT)
            calls = sdk.api.call_count
            second_operation = "resolve" if first_operation == "overview" else "overview"
            getattr(resolver, second_operation)(CURRENT)
            self.assertEqual(sdk.api.call_count, calls)
            self.assertEqual(sum(call.args == (NEXT,) for call in detail.call_args_list), 1)

    def test_overview_never_uses_search_episode_count_as_total(self):
        resolver, _, detail = self.resolver([metadata(CURRENT, "春风", episode_cnt=99)])
        result = resolver.overview(CURRENT)
        self.assertEqual(result["seasons"][0]["series"]["totalEpisodes"], 2)
        detail.assert_called_once_with(CURRENT)

    def test_overview_metadata_episode_list_is_real_count_and_needs_no_detail(self):
        resolver, _, detail = self.resolver([metadata(CURRENT, "春风", episode_cnt=99,
            video_list=[{"vid_index": 1}, {"vid_index": 2}, {"vid_index": 2}, {"vid_index": 3}])])
        self.assertEqual(resolver.overview(CURRENT)["seasons"][0]["series"]["totalEpisodes"], 3)
        detail.assert_not_called()

    def test_actual_schema_without_multiseason_flag_keeps_official_relation(self):
        rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, actors=(), total_episode=79,
                         video_list=[{"vid_index": 1, "vid": "11111111"}]),
                metadata(NEXT, "家里家外2", season=2, album=ALBUM, actors=(), total_episode=111,
                         video_list=[{"vid_index": 1, "vid": "22222222"}])]
        for row in rows:
            row.pop("is_multi_season")
        resolver, _, detail = self.resolver(rows)
        result = resolver.overview(CURRENT)
        self.assertEqual((result["status"], result["source"]), ("found", "official"))
        self.assertEqual([row["series"]["totalEpisodes"] for row in result["seasons"]], [79, 111])
        self.assertEqual(resolver.resolve(CURRENT)["next"]["id"], NEXT)
        detail.assert_not_called()

    def test_metadata_only_batch_supplements_missing_identity_for_title_family_only(self):
        rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, total_episode=79,
                         video_list=[{"vid_index": 1, "vid": "11111111"}]),
                metadata(NEXT, "家里家外2", season=2, album=ALBUM, total_episode=111,
                         video_list=[{"vid_index": 1, "vid": "22222222"}]),
                metadata(OTHER, "无关作品", season=2, album="111111111", total_episode=8)]
        resolver, sdk, detail = self.resolver(rows)
        def partial(method, path, **kwargs):
            result = sdk._api(method, path, **kwargs)
            if method == "POST" and "," in kwargs["body"]["series_id"]:
                for entry in result["data"].values():
                    video = entry["video_data"]
                    for field in ("related_album_id", "season_index", "video_list", "total_episode"):
                        video.pop(field, None)
            return result
        sdk.api.side_effect = partial
        result = resolver.overview(CURRENT)
        self.assertEqual([row["series"]["id"] for row in result["seasons"]], [CURRENT, NEXT])
        self.assertEqual([row["series"]["totalEpisodes"] for row in result["seasons"]], [79, 111])
        self.assertEqual(resolver.resolve(CURRENT)["next"]["id"], NEXT)
        single_ids = [call.kwargs["body"]["series_id"] for call in sdk.api.call_args_list
                      if call.args[0] == "POST" and "," not in call.kwargs["body"]["series_id"]]
        self.assertEqual(single_ids, [CURRENT, NEXT])
        detail.assert_not_called()

    def test_missing_batch_total_does_not_use_one_playable_row_as_total(self):
        rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, total_episode=79),
                metadata(NEXT, "家里家外2", season=2, album=ALBUM, total_episode=111)]
        resolver, sdk, detail = self.resolver(rows)
        def partial(method, path, **kwargs):
            result = sdk._api(method, path, **kwargs)
            if method == "POST" and kwargs["body"]["series_id"] == NEXT:
                result["data"][NEXT]["video_data"]["video_list"] = [{"vid_index": 1, "vid": "22222222"}]
            elif method == "POST" and "," in kwargs["body"]["series_id"]:
                result["data"][NEXT]["video_data"].pop("total_episode")
            return result
        sdk.search_rows.append(metadata(OTHER, "无关作品"))
        sdk.values[OTHER] = sdk.search_rows[-1]
        sdk.api.side_effect = partial
        result = resolver.overview(CURRENT)
        self.assertEqual(result["seasons"][1]["series"]["totalEpisodes"], 111)
        detail.assert_not_called()

    def test_partial_batch_first_episode_is_not_cached_as_the_season_total(self):
        rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, total_episode=79),
                metadata(NEXT, "家里家外2", season=2, album=ALBUM, total_episode=111,
                         video_list=[{"vid_index": 1, "vid": "22222222"}]),
                metadata(OTHER, "无关作品", season=2, album="111111111", total_episode=8)]
        resolver, sdk, detail = self.resolver(rows)
        def partial(method, path, **kwargs):
            result = sdk._api(method, path, **kwargs)
            if method == "POST" and "," in kwargs["body"]["series_id"]:
                for entry in result["data"].values():
                    entry["video_data"].pop("total_episode", None)
                result["data"][NEXT]["video_data"]["video_list"] = [{"vid_index": 1, "vid": "22222222"}]
            return result
        sdk.api.side_effect = partial
        first = resolver.overview(CURRENT)
        self.assertEqual(first["seasons"][1]["series"]["totalEpisodes"], 111)
        self.assertEqual(resolver.resolve(CURRENT)["next"]["totalEpisodes"], 111)
        self.assertEqual(resolver.overview(CURRENT)["seasons"][1]["series"]["totalEpisodes"], 111)
        single_ids = [call.kwargs["body"]["series_id"] for call in sdk.api.call_args_list
                      if call.args[0] == "POST" and "," not in call.kwargs["body"]["series_id"]]
        self.assertEqual(single_ids, [CURRENT, NEXT])
        detail.assert_not_called()

    def test_partial_batch_can_use_complete_single_series_video_list_when_total_is_absent(self):
        complete_episodes = [{"vid_index": number, "vid": str(22000000 + number)} for number in range(1, 112)]
        rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, total_episode=79),
                metadata(NEXT, "家里家外2", season=2, album=ALBUM, video_list=complete_episodes),
                metadata(OTHER, "无关作品", total_episode=8)]
        resolver, sdk, detail = self.resolver(rows)
        def partial(method, path, **kwargs):
            result = sdk._api(method, path, **kwargs)
            if method == "POST" and "," in kwargs["body"]["series_id"]:
                result["data"][NEXT]["video_data"]["video_list"] = complete_episodes[:1]
            return result
        sdk.api.side_effect = partial
        result = resolver.overview(CURRENT)
        self.assertEqual(result["seasons"][1]["series"]["totalEpisodes"], 111)
        self.assertEqual(resolver.resolve(CURRENT)["firstEpisode"], 1)
        self.assertEqual(sum(call.args[0] == "POST" and call.kwargs["body"]["series_id"] == NEXT
                             for call in sdk.api.call_args_list), 1)
        detail.assert_not_called()

    def test_partial_batch_count_supplement_failure_is_retryable_and_not_cached(self):
        rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, total_episode=79),
                metadata(NEXT, "家里家外2", season=2, album=ALBUM, total_episode=111),
                metadata(OTHER, "无关作品", total_episode=8)]
        resolver, sdk, _ = self.resolver(rows)
        failing = [True]
        def partial(method, path, **kwargs):
            ids = kwargs.get("body", {}).get("series_id", "")
            if method == "POST" and ids == NEXT and failing[0]:
                raise SeasonLookupError("固定总集数补读失败")
            result = sdk._api(method, path, **kwargs)
            if method == "POST" and "," in ids:
                video = result["data"][NEXT]["video_data"]
                video.pop("total_episode")
                video["video_list"] = [{"vid_index": 1, "vid": "22222222"}]
            return result
        sdk.api.side_effect = partial
        with self.assertRaises(SeasonLookupError):
            resolver.overview(CURRENT)
        self.assertFalse(resolver.values)
        failing[0] = False
        self.assertEqual(resolver.overview(CURRENT)["seasons"][1]["series"]["totalEpisodes"], 111)

    def test_title_matched_season_also_supplements_partial_batch_count_without_reading_wrong_cast(self):
        complete_episodes = [{"vid_index": number, "vid": str(22000000 + number)} for number in range(1, 112)]
        rows = [metadata(CURRENT, "春风", total_episode=12),
                metadata(NEXT, "春风第二季", video_list=complete_episodes),
                metadata(OTHER, "春风第三季", actors=("丙", "丁"), total_episode=8)]
        resolver, sdk, detail = self.resolver(rows)
        def partial(method, path, **kwargs):
            result = sdk._api(method, path, **kwargs)
            if method == "POST" and "," in kwargs["body"]["series_id"]:
                result["data"][NEXT]["video_data"]["video_list"] = complete_episodes[:1]
            return result
        sdk.api.side_effect = partial
        result = resolver.overview(CURRENT)
        self.assertEqual(result["source"], "title")
        self.assertEqual([row["series"]["totalEpisodes"] for row in result["seasons"]], [12, 111])
        single_ids = [call.kwargs["body"]["series_id"] for call in sdk.api.call_args_list
                      if call.args[0] == "POST" and "," not in call.kwargs["body"]["series_id"]]
        self.assertEqual(single_ids, [CURRENT, NEXT])
        detail.assert_not_called()

    def test_unique_video_list_supplies_true_count_and_playable_first(self):
        resolver, _, detail = self.resolver([metadata(CURRENT, "家里家外", episode_cnt=99,
            video_list_unique=[{"vid_index": 1, "vid": "11111111"}, {"vid_index": 2, "vid": "22222222"},
                               {"vid_index": 2, "vid": "22222222"}, {"vid_index": 0, "vid": "33333333"}])])
        self.assertEqual(resolver.overview(CURRENT)["seasons"][0]["series"]["totalEpisodes"], 2)
        detail.assert_not_called()

    def test_identity_supplement_failure_is_not_cached_and_retry_recovers(self):
        rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, total_episode=79),
                metadata(NEXT, "家里家外2", season=2, album=ALBUM, total_episode=111),
                metadata(OTHER, "无关作品", season=2, album="111111111", total_episode=8)]
        resolver, sdk, _ = self.resolver(rows)
        failing = [True]
        def partial(method, path, **kwargs):
            if method == "POST" and kwargs["body"]["series_id"] == NEXT and failing[0]:
                raise SeasonLookupError("固定单剧补读失败")
            result = sdk._api(method, path, **kwargs)
            if method == "POST" and "," in kwargs["body"]["series_id"]:
                video = result["data"][NEXT]["video_data"]
                video.pop("related_album_id")
                video.pop("season_index")
            return result
        sdk.api.side_effect = partial
        with self.assertRaises(SeasonLookupError):
            resolver.overview(CURRENT)
        self.assertFalse(resolver.values)
        failing[0] = False
        self.assertEqual(resolver.overview(CURRENT)["status"], "found")

    def test_identity_supplement_still_requires_official_album_and_respects_disabled_flag(self):
        for disabled in (False, True):
            rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, total_episode=79),
                    metadata(NEXT, "家里家外2", season=2, album="111111111", total_episode=111),
                    metadata(OTHER, "无关作品", total_episode=8)]
            resolver, sdk, _ = self.resolver(rows)
            def partial(method, path, **kwargs):
                result = sdk._api(method, path, **kwargs)
                if method == "POST" and "," in kwargs["body"]["series_id"]:
                    video = result["data"][NEXT]["video_data"]
                    video.pop("related_album_id")
                    video.pop("season_index")
                    if disabled:
                        video["is_multi_season"] = False
                return result
            sdk.api.side_effect = partial
            self.assertEqual(resolver.overview(CURRENT)["status"], "single")
            self.assertIsNone(resolver.resolve(CURRENT)["next"])
            next_reads = [call for call in sdk.api.call_args_list if call.args[0] == "POST"
                          and call.kwargs["body"]["series_id"] == NEXT]
            self.assertEqual(len(next_reads), 0 if disabled else 1)

    def test_known_album_missing_index_supplements_renamed_candidate(self):
        rows = [metadata(CURRENT, "家里家外", season=1, album=ALBUM, total_episode=79),
                metadata(NEXT, "改名的新季", season=2, album=ALBUM, total_episode=111),
                metadata(OTHER, "无关作品", total_episode=8)]
        resolver, sdk, _ = self.resolver(rows)
        def partial(method, path, **kwargs):
            result = sdk._api(method, path, **kwargs)
            if method == "POST" and "," in kwargs["body"]["series_id"]:
                result["data"][NEXT]["video_data"].pop("season_index")
            return result
        sdk.api.side_effect = partial
        result = resolver.overview(CURRENT)
        self.assertEqual([row["series"]["id"] for row in result["seasons"]], [CURRENT, NEXT])

    def test_null_primary_video_list_can_use_unique_list(self):
        resolver, _, detail = self.resolver([metadata(CURRENT, "家里家外", video_list=None,
            video_list_unique=[{"vid_index": 1, "vid": "11111111"}])])
        self.assertEqual(resolver.overview(CURRENT)["seasons"][0]["series"]["totalEpisodes"], 1)
        detail.assert_not_called()

    def test_overview_and_resolve_reuse_official_metadata_playability_without_second_detail(self):
        resolver, sdk, detail = self.resolver([
            metadata(CURRENT, "春风", video_list=[{"vid_index": 1, "vid": "11111111"}], total_episode=12),
            metadata(NEXT, "春风第二季", video_list=[{"vid_index": 1, "vid": "22222222"}], total_episode=22)])
        resolver.overview(CURRENT)
        count = sdk.api.call_count
        result = resolver.resolve(CURRENT)
        self.assertEqual((result["status"], result["firstEpisode"], result["next"]["totalEpisodes"]),
                         ("found", 1, 22))
        self.assertEqual(sdk.api.call_count, count)
        detail.assert_not_called()

    def test_metadata_indexes_without_video_identity_do_not_bypass_detail_validation(self):
        resolver, _, detail = self.resolver([
            metadata(CURRENT, "春风", total_episode=12),
            metadata(NEXT, "春风第二季", video_list=[{"vid_index": 1}], total_episode=22)])
        detail.side_effect = None
        detail.return_value = {"series": {"id": NEXT}, "episodes": []}
        resolver.overview(CURRENT)
        self.assertEqual(resolver.resolve(CURRENT)["status"], "none")
        detail.assert_called_once_with(NEXT)

    def test_overview_failures_are_not_cached_and_retry_recovers(self):
        resolver, _, detail = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
        original = detail.side_effect
        detail.side_effect = RuntimeError("固定失败夹具")
        with self.assertRaises(RuntimeError):
            resolver.overview(CURRENT)
        self.assertFalse(resolver.values)
        detail.side_effect = original
        self.assertEqual(resolver.overview(CURRENT)["status"], "found")

    def test_overview_cache_ttl_refresh_capacity_and_defensive_copy(self):
        now = [100.0]
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")],
                                       capacity=1, ttl=10, empty_ttl=2, clock=lambda: now[0])
        first = resolver.overview(CURRENT)
        calls = sdk.api.call_count
        first["seasons"][0]["series"]["totalEpisodes"] = 999
        self.assertEqual(resolver.overview(CURRENT)["seasons"][0]["series"]["totalEpisodes"], 2)
        self.assertEqual(sdk.api.call_count, calls)
        now[0] += 11
        resolver.overview(CURRENT)
        self.assertGreater(sdk.api.call_count, calls)
        calls = sdk.api.call_count
        resolver.overview(CURRENT, refresh=True)
        self.assertGreater(sdk.api.call_count, calls)
        resolver.overview(NEXT)
        self.assertEqual(list(resolver.values), [NEXT])

    def test_filling_other_view_does_not_extend_shared_candidate_ttl(self):
        now = [100.0]
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")],
                                       ttl=10, clock=lambda: now[0])
        resolver.resolve(CURRENT)
        count = sdk.api.call_count
        now[0] += 8
        resolver.overview(CURRENT)
        self.assertEqual(sdk.api.call_count, count)
        now[0] += 3
        resolver.resolve(CURRENT)
        self.assertGreater(sdk.api.call_count, count)

    def test_parallel_overview_and_resolve_share_discovery(self):
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风"), metadata(NEXT, "春风第二季")])
        started, release = threading.Event(), threading.Event()
        original = sdk._api
        def delayed(method, path, **kwargs):
            if not started.is_set():
                started.set()
                self.assertTrue(release.wait(timeout=5))
            return original(method, path, **kwargs)
        sdk.api.side_effect = delayed
        results = []
        first = threading.Thread(target=lambda: results.append(resolver.overview(CURRENT)))
        second = threading.Thread(target=lambda: results.append(resolver.resolve(CURRENT)))
        first.start()
        self.assertTrue(started.wait(timeout=3))
        second.start()
        release.set()
        first.join(timeout=5)
        second.join(timeout=5)
        self.assertEqual(len(results), 2)
        self.assertEqual(sdk.api.call_count, 3)


if __name__ == "__main__":
    unittest.main()
