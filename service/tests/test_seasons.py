"""Season continuity contracts; public metadata only, no account or media RPCs."""
from copy import deepcopy
from pathlib import Path
import sys
import threading
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
            return {"search_tabs": [{"data": deepcopy(self.search_rows), "has_more": False}]}
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
                return {"search_tabs": [{"data": deepcopy(candidates), "has_more": False}]}
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

    def test_search_pagination_must_progress_and_failures_are_not_cached(self):
        resolver, sdk, _ = self.resolver([metadata(CURRENT, "春风")])
        def stuck(method, path, **kwargs):
            if method == "GET":
                return {"search_tabs": [{"data": sdk.search_rows, "has_more": True, "next_offset": 0}]}
            return sdk._api(method, path, **kwargs)
        sdk.api.side_effect = stuck
        with self.assertRaises(SeasonLookupError):
            resolver.resolve(CURRENT)
        self.assertFalse(resolver.values)

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
