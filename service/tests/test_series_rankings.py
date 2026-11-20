"""Series ranking protocol fixtures contain only synthetic public catalog data."""
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from series_rankings import BOARDS, CELL_ID, _entry, read_series_rank


def video(sid="12345678", **fields):
    return {"series_id": sid, "title": "测试系列", "episode_cnt": 207, "score": "8.4", **fields}


def page(videos, more=False, offset=10):
    return {"code": 0, "data": {"cell_view": {"cell_data": [{"video_data": [row]} for row in videos],
                                                "has_more": more, "next_offset": offset}}}


class SeriesRankingsTests(unittest.TestCase):
    def test_each_board_uses_its_official_selector_with_signing(self):
        for board, selector in BOARDS.items():
            with self.subTest(board=board):
                sdk = types.SimpleNamespace(api=Mock(return_value=page([video()])))
                self.assertEqual(read_series_rank(sdk, board)[0]["series_id"], "12345678")
                args, kwargs = sdk.api.call_args
                self.assertEqual(args, ("GET", "/reading/bookapi/bookmall/cell/change/v"))
                self.assertTrue(kwargs["signed"])
                self.assertEqual(kwargs["extra_query"]["cell_id"], CELL_ID)
                self.assertEqual(kwargs["extra_query"]["selected_items"], "series_album")
                self.assertEqual(kwargs["extra_query"]["sub_selected_items"], selector)

    def test_series_entry_follows_official_destination_and_drops_other_season_counts(self):
        source = video(jump_schema="dragon8662://videoDetail?video_series_id=23456789&source=4",
                       sub_title_list=[{"content": "漫剧"}, {"content": "更新至第3季"}],
                       rec_text_item={"RecommendText": "994万推荐"})
        result = _entry(source)
        self.assertEqual(result["series_id"], "23456789")
        self.assertEqual(result["episode_cnt"], 0)
        self.assertEqual(result["score"], "")
        self.assertEqual(result["tags"], ["漫剧", "更新至第3季", "994万推荐"])
        self.assertEqual(source["episode_cnt"], 207)

    def test_unknown_or_ambiguous_schema_keeps_valid_original_target(self):
        for schema in ("https://catalog.example/?video_series_id=23456789",
                       "dragon8662://other?video_series_id=23456789",
                       "dragon8662://videoDetail?video_series_id=bad",
                       "dragon8662://videoDetail?video_series_id=23456789&video_series_id=34567890",
                       "http://[", ""):
            with self.subTest(schema=schema):
                row = _entry(video(jump_schema=schema))
                self.assertEqual(row["series_id"], "12345678")
                self.assertEqual(row["episode_cnt"], 207)

    def test_pagination_deduplicates_and_uses_upstream_cursor_and_same_session(self):
        sdk = types.SimpleNamespace(api=Mock(side_effect=[
            page([video(), video(), video("invalid")], more=True, offset=10),
            page([video("23456789")], more=False, offset=20)]))
        rows = read_series_rank(sdk, "new")
        self.assertEqual([row["series_id"] for row in rows], ["12345678", "23456789"])
        first = sdk.api.call_args_list[0].kwargs["extra_query"]
        second = sdk.api.call_args_list[1].kwargs["extra_query"]
        self.assertEqual(second["offset"], "10")
        self.assertEqual(first["session_uuid"], second["session_uuid"])

    def test_repeated_cursor_stops_even_when_has_more(self):
        sdk = types.SimpleNamespace(api=Mock(return_value=page([video()], more=True, offset=0)))
        self.assertEqual(len(read_series_rank(sdk)), 1)
        self.assertEqual(sdk.api.call_count, 1)

    def test_invalid_rows_with_advancing_cursors_have_a_page_budget(self):
        responses = [page([None], more=True, offset=(n + 1) * 10) for n in range(30)]
        sdk = types.SimpleNamespace(api=Mock(side_effect=responses))
        self.assertEqual(read_series_rank(sdk), [])
        self.assertEqual(sdk.api.call_count, 10)

    def test_business_failure_or_missing_cells_is_not_an_empty_success(self):
        for response in ({"code": 1, "data": {}}, {"code": 0, "data": {}}, None):
            with self.subTest(response=response):
                sdk = types.SimpleNamespace(api=Mock(return_value=response))
                with self.assertRaises(ValueError):
                    read_series_rank(sdk)

    def test_unsupported_board_never_calls_upstream(self):
        sdk = types.SimpleNamespace(api=Mock())
        with self.assertRaises(ValueError):
            read_series_rank(sdk, "hot")
        sdk.api.assert_not_called()


if __name__ == "__main__":
    unittest.main()
