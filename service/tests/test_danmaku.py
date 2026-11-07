"""Official response shape, using synthetic comment and account identifiers."""
import copy
import json
import math
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from danmaku import list_request, page
from provider import Provider, ProviderError

SID, VID = "12345678", "23456789"


def row(identifier="34567890", at=2925, text="真实时间点的测试弹幕"):
    return {"data_type": 4, "comment": {"comment_id": identifier,
        "common": {"group_id": VID, "service_id": 20, "status": 1,
                   "create_timestamp": 1790000000, "content": {"text": text},
                   "user_info": {"base_info": {"user_id": "private-user"}}},
        "expand": {"offset_time": at, "extra": {"trace": "private-request"}}}}


def response(rows=None, start=0, end=30000):
    return {"code": 0, "data": {"data_list": [row()] if rows is None else rows,
        "common_list_info": {"has_more": True, "cursor": json.dumps({"start_offset_time": start, "end_offset_time": end})},
        "extra": {"next_query_danmaku_list_time": end}}}


class ContractTests(unittest.TestCase):
    def test_ordinary_comments_cannot_substitute_for_mobile_danmaku(self):
        body = list_request(SID, VID, 45.5, 179.42)
        self.assertEqual((body["comment_source"], body["server_channel"], body["comment_type"]), (601, 1000, 20))
        self.assertEqual(body["business_param"]["start_offset_time"], 30000)
        self.assertEqual(body["business_param"]["playlet_item_duration"], 179420)
        self.assertEqual(body["group_id"], VID)

    def test_millisecond_offset_is_converted_without_wall_clock_substitution(self):
        value = page(response(), SID, VID, 0, 179.42)
        self.assertEqual(value["items"], [{"id": "34567890", "text": "真实时间点的测试弹幕", "time": 2.925}])
        self.assertEqual((value["start"], value["end"]), (0, 30))
        self.assertTrue(value["hasMore"])
        self.assertNotIn("private-user", json.dumps(value))
        self.assertNotIn("private-request", json.dumps(value))

    def test_other_episode_regular_comments_missing_times_and_deleted_rows_are_ignored(self):
        rows = [row()]
        wrong = row("34567891"); wrong["comment"]["common"]["group_id"] = "99999999"; rows.append(wrong)
        regular = row("34567892"); regular["comment"]["common"]["service_id"] = 4; rows.append(regular)
        missing = row("34567893"); del missing["comment"]["expand"]["offset_time"]; rows.append(missing)
        deleted = row("34567894"); deleted["comment"]["common"]["status"] = 0; rows.append(deleted)
        rows += [row("34567895", math.nan), row("34567896", -1), row("34567897", True)]
        self.assertEqual(len(page(response(rows), SID, VID, 0, 179.42)["items"]), 1)

    def test_window_order_deduplication_and_real_empty_window(self):
        value = page(response([row("34567892", 10000), row(), row()]), SID, VID, 0, 179.42)
        self.assertEqual([item["time"] for item in value["items"]], [2.925, 10])
        empty = page(response([], start=60000, end=90000), SID, VID, 70, 80)
        self.assertEqual(empty["items"], [])
        self.assertFalse(empty["hasMore"])
        self.assertEqual(empty["end"], 80)

    def test_malformed_or_failed_upstream_is_not_reported_as_empty_success(self):
        for value in (None, {"code": 100}, {"code": 0, "data": {}}, {"code": 0, "data": []}):
            with self.assertRaises(ValueError): page(value, SID, VID, 0, 179.42)


class ProviderTests(unittest.TestCase):
    def setUp(self):
        work = Path(__file__).parent / ".work" / "danmaku"
        self.sdk = types.SimpleNamespace(get_episodes=Mock(return_value=(
            {"series_id": SID, "title": "测试剧", "episode_cnt": 1},
            [{"index": 1, "vid": VID, "duration": 179, "title": "第一集"}])))
        self.account = types.SimpleNamespace(load_session=Mock(return_value={}),
            _session_identity=Mock(return_value="public"), _account_changed=Mock(return_value=False),
            _call=Mock(return_value=response()), _json=lambda value: value)
        self.provider = Provider(work, self.sdk, self.account)
        self.addCleanup(self.provider.close)

    def test_reads_are_signed_through_existing_sdk_and_coalesced_by_window(self):
        self.provider.danmaku(SID, 1, 0, 179.42)
        self.provider.danmaku(SID, 1, 2, 179.42)
        self.account._call.assert_called_once()
        call = self.account._call.call_args
        self.assertEqual(call.args, ("POST", "/novel/commentapi/comment/list/23456789/v1/"))
        self.assertEqual(call.kwargs["body"]["comment_type"], 20)

    def test_refresh_and_identity_changes_do_not_reuse_previous_account_result(self):
        self.provider.danmaku(SID, 1)
        self.provider.danmaku(SID, 1, refresh=True)
        self.account._session_identity.return_value = "another-account"
        self.provider.danmaku(SID, 1)
        self.assertEqual(self.account._call.call_count, 3)

    def test_account_changed_mid_request_discards_reply(self):
        self.account._account_changed.return_value = True
        with self.assertRaises(ProviderError) as error: self.provider.danmaku(SID, 1)
        self.assertEqual(error.exception.code, "ACCOUNT_CHANGED")

    def test_invalid_times_or_episodes_never_call_upstream(self):
        for value in (-1, math.nan, True, "20"):
            with self.assertRaises(ProviderError): self.provider.danmaku(SID, 1, value)
        with self.assertRaises(ProviderError): self.provider.danmaku(SID, 2)
        self.account._call.assert_not_called()
