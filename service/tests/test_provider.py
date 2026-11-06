"""Offline gateway/provider contracts; all account fixtures are synthetic."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import threading
import time
import types
import json
import tempfile
import ast
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from gateway import create_app
from provider import CatalogCache, Provider, ProviderError, RequestCache, SessionVault, normalize_series


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(__file__).resolve().parent / ".work" / self._testMethodName
        self.work.mkdir(parents=True, exist_ok=True)
        (self.work / "catalog-cache.json").unlink(missing_ok=True)
        self.sdk = types.SimpleNamespace(
            get_episodes=Mock(return_value=({"series_id": "12345678", "title": "测试短剧", "episode_cnt": 2},
                 [{"index": 1, "vid": "23456789", "title": "第一集", "duration": 60},
                  {"index": 2, "vid": "23456790", "title": "第二集", "duration": 60}])),
            search=Mock(return_value=[{"series_id": "12345678", "title": "测试短剧", "episode_cnt": 2}]),
            browse=Mock(return_value=[{"series_id": "12345678", "title": "测试真人剧", "episode_cnt": 2}]),
            feed=Mock(return_value={"items": [{"seriesId": "34567890", "title": "推荐剧"}], "session": "test-feed", "offset": 1}),
            filters=Mock(return_value=[{"type": "category_dim_theme", "items": [{"id": "all", "name": "全部"},
                       {"id": "cate_plot", "name": "剧情"}]}]))
        self.account = types.SimpleNamespace(
            public_session=Mock(return_value={"loggedIn": True, "uid": "synthetic-user", "userName": "测试", "mobile": "138****0000"}),
            load_session=Mock(return_value={"uid": "synthetic-user", "token": "synthetic-only"}),
            save_session=Mock(), set_favorite=Mock(return_value={"ok": True}),
            _history_all_cached=Mock(return_value=([], 0, True, "", False)),
            remote_progress=Mock(return_value={"ok": True, "episode": 0, "updatedAt": 0, "reason": "absent"}),
            _session_identity=Mock(return_value="synthetic-identity"), _account_changed=Mock(return_value=False),
            remote_history_page=Mock(return_value={"ok": True, "items": [], "total": 0, "nextOffset": 0, "hasMore": False}),
            _call=Mock(return_value={"code": 0, "data": {}}), _json=lambda response: response)
        self.mfa_context = {}
        def save_mfa(value):
            self.mfa_context = {**value, "at": value.get("at") or time.time()}
        self.account.load_mfa = Mock(side_effect=lambda: dict(self.mfa_context))
        self.account.save_mfa = Mock(side_effect=save_mfa)
        self.account.mask_mobile = lambda value: str(value)[:3] + "****" + str(value)[-4:]
        self.account.send_code = Mock(return_value={"ok": True})
        self.account.verify_mfa = Mock(return_value={"ok": False, "pending": True})
        self.account.sms_login = Mock(return_value={"ok": False, "mfaRequired": True, "mfa": {
            "cookie": "synthetic-cookie-fixture", "encryptUid": "synthetic-private-context", "smsCodeKey": "synthetic-key",
            "verifyWays": [{"way": "mobile_up_sms_verify", "channelMobile": "10690000", "smsContent": "测试验证"}],
            "at": time.time()}})
        self.provider = Provider(self.work, self.sdk, self.account)
        self.addCleanup(self.provider.close)

    def test_model_normalization_matches_typescript_contract(self):
        model = normalize_series({"series_id": "12345678", "title": "剧", "episode_cnt": 6,
                                  "category": "剧情 / 科幻", "celebrities": [{"演员": "演员甲"}]})
        self.assertEqual(model["id"], "12345678")
        self.assertEqual(model["totalEpisodes"], 6)
        self.assertEqual(model["tags"], ["剧情", "科幻"])
        self.assertEqual(model["actors"], ["演员甲"])

    def test_cached_detail_only_fetches_sdk_once(self):
        self.assertEqual(self.provider.detail("12345678")["episodes"][1]["vid"], "23456790")
        self.provider.detail("12345678")
        self.sdk.get_episodes.assert_called_once()

    @staticmethod
    def raw_history(start, count, updated_at=1790000000000):
        return [{"book_id_str": str(12345678 + index), "book_name": "测试剧", "vid_index": 3,
                 "read_timestamp_ms": updated_at - index * 1000, "episode_cnt": 40,
                 "current_play_position": 12000} for index in range(start, start + count)]

    def test_history_returns_entire_server_page_and_advances_by_consumed_rows(self):
        # The server ignores requested limit=100 and returns 500; none are cut away.
        self.account.remote_history_page.side_effect = [
            {"ok": True, "items": self.raw_history(0, 500), "total": 650, "nextOffset": 500, "hasMore": True},
            {"ok": True, "items": self.raw_history(500, 150), "total": 650, "nextOffset": 650, "hasMore": False}]
        first = self.provider.history(limit=100)
        self.assertEqual(len(first["items"]), 500)
        self.assertTrue(first["hasMore"])
        self.assertFalse(first["complete"])
        second = self.provider.history(first["nextCursor"], limit=100)
        self.assertEqual(len(second["items"]), 150)
        self.assertTrue(second["complete"])
        self.assertFalse(second["hasMore"])
        self.assertEqual(self.account.remote_history_page.call_args.kwargs["offset"], 500)
        self.assertEqual(len({item["series"]["id"] for item in first["items"] + second["items"]}), 650)
        self.account._call.assert_not_called()

    def test_history_original_timestamp_is_seconds_and_zero_stays_unknown(self):
        raw = self.raw_history(0, 1)
        raw += [{**raw[0], "book_id_str": "23456789", "read_timestamp_ms": 0}]
        self.account.remote_history_page.return_value = {"ok": True, "items": raw, "hasMore": False}
        items = self.provider.history()["items"]
        self.assertEqual(items[0]["watchedAt"], 1790000000)
        self.assertEqual(items[1]["watchedAt"], 0)
        self.assertEqual(items[0]["position"], 12)

    def test_history_deduplicates_by_actual_latest_time_not_larger_episode(self):
        raw = self.raw_history(0, 1)
        raw[0]["vid_index"] = 30
        raw += [{**raw[0], "vid_index": 2, "read_timestamp_ms": raw[0]["read_timestamp_ms"] + 1000}]
        self.account.remote_history_page.return_value = {"ok": True, "items": raw, "hasMore": False}
        items = self.provider.history()["items"]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["episode"], 2)

    def test_history_failed_later_page_is_retryable_without_discarding_previous_records(self):
        self.account.remote_history_page.side_effect = [
            {"ok": True, "items": self.raw_history(0, 100), "total": 200, "nextOffset": 100, "hasMore": True},
            {"ok": False},
            {"ok": True, "items": self.raw_history(100, 100), "total": 200, "nextOffset": 200, "hasMore": False}]
        first = self.provider.history()
        failed = self.provider.history(first["nextCursor"])
        self.assertEqual(failed["items"], [])
        self.assertTrue(failed["hasMore"])
        self.assertEqual(failed["nextCursor"], first["nextCursor"])
        self.assertIn("保留", failed["warning"])
        recovered = self.provider.history(failed["nextCursor"])
        self.assertEqual(len(first["items"] + recovered["items"]), 200)
        self.assertTrue(recovered["complete"])

    def test_history_cursor_cannot_cross_accounts_or_be_forged(self):
        self.account.remote_history_page.return_value = {"ok": True, "items": self.raw_history(0, 100), "total": 300,
                                                        "nextOffset": 100, "hasMore": True}
        first = self.provider.history()
        with self.assertRaises(ProviderError) as error:
            self.provider.history(first["nextCursor"] + "tampered")
        self.assertEqual(error.exception.code, "HISTORY_CURSOR_INVALID")
        self.account.public_session.return_value = {"loggedIn": True, "uid": "another-user"}
        with self.assertRaises(ProviderError) as error:
            self.provider.history(first["nextCursor"])
        self.assertEqual(error.exception.code, "ACCOUNT_CHANGED")
        self.account.remote_history_page.assert_called_once()

    def test_history_repeated_page_stops_with_warning_instead_of_false_completion(self):
        self.account.remote_history_page.return_value = {"ok": True, "items": self.raw_history(0, 100), "total": 300,
                                                        "nextOffset": 100, "hasMore": True}
        first = self.provider.history()
        second = self.provider.history(first["nextCursor"])
        self.assertEqual(second["items"], [])
        self.assertFalse(second["complete"])
        self.assertFalse(second["hasMore"])
        self.assertIn("重复", second["warning"])

    def test_history_page_cache_reuses_one_read_and_refresh_reloads(self):
        self.provider.history()
        self.provider.history()
        self.account.remote_history_page.assert_called_once()
        self.provider.history(refresh=True)
        self.assertEqual(self.account.remote_history_page.call_count, 2)

    def test_history_account_change_during_page_fetch_discards_old_results(self):
        self.account._account_changed.return_value = True
        with self.assertRaises(ProviderError) as error:
            self.provider.history()
        self.assertEqual(error.exception.code, "ACCOUNT_CHANGED")

    def test_discover_respects_selected_genre_and_recommend_uses_feed(self):
        self.assertEqual(self.provider.home("short_play")["items"][0]["title"], "测试真人剧")
        self.sdk.browse.assert_called_once_with("short_play", sort="hot_score", max_items=30)
        self.sdk.feed.assert_not_called()
        self.assertEqual(self.provider.home("short_play", mode="recommend")["items"][0]["id"], "34567890")
        self.sdk.feed.assert_called_once()

    def test_browse_filters_are_normalized_for_renderer(self):
        result = self.provider.browse("short_play")
        self.assertEqual(result["filters"]["themes"], ["剧情"])
        self.assertEqual(result["filters"]["themeOptions"], [{"id": "cate_plot", "name": "剧情"}])

    def test_invalid_query_does_not_touch_sdk(self):
        with self.assertRaises(ProviderError):
            self.provider.search("\n")
        self.sdk.search.assert_not_called()

    def test_upstream_error_never_exposes_secret_text(self):
        self.sdk.search.side_effect = RuntimeError("token=very-private-fixture-value")
        with self.assertRaises(ProviderError) as error:
            self.provider.search("测试")
        self.assertNotIn("very-private", error.exception.message)

    def test_backfill_does_not_write_cloud_history(self):
        result = self.provider.progress({"series": {"id": "12345678"}, "episode": 1, "intent": "backfill", "expectedUid": "synthetic-user"})
        self.assertTrue(result["skipped"])
        self.account._call.assert_not_called()

    def test_playback_action_writes_and_duplicate_is_coalesced(self):
        progress = {"series": {"id": "12345678", "title": "测试"}, "episode": 2, "position": 10, "duration": 60, "intent": "active", "expectedUid": "synthetic-user"}
        self.assertTrue(self.provider.progress(progress)["synced"])
        self.assertTrue(self.provider.progress(progress)["skipped"])
        self.assertEqual(self.account._call.call_count, 1)
        body = self.account._call.call_args.kwargs["body"]["update_datas"][0]
        self.assertEqual(body["vid_index"], 2)
        self.assertEqual(body["current_play_position"], 10000)

    def test_account_change_cancels_progress_before_write(self):
        self.account._account_changed.return_value = True
        with self.assertRaises(ProviderError) as error:
            self.provider.progress({"series": {"id": "12345678"}, "episode": 1, "expectedUid": "synthetic-user"})
        self.assertEqual(error.exception.code, "ACCOUNT_CHANGED")
        self.account._call.assert_not_called()

    def test_wrong_expected_uid_does_not_write_to_current_account(self):
        with self.assertRaises(ProviderError) as error:
            self.provider.progress({"series": {"id": "12345678"}, "episode": 1, "expectedUid": "previous-user"})
        self.assertEqual(error.exception.status, 409)
        self.account._call.assert_not_called()
        with self.assertRaises(ProviderError):
            self.provider.favorite("12345678", True, "previous-user")
        self.account.set_favorite.assert_not_called()

    def test_invalid_progress_data_never_reaches_cloud_write(self):
        for values in ({"series": []}, {"series": {"id": "12345678"}, "episode": "invalid"},
                       {"series": {"id": "12345678"}, "episode": 1, "position": float("nan")}):
            with self.assertRaises(ProviderError) as error:
                self.provider.progress({**values, "expectedUid": "synthetic-user"})
            self.assertEqual(error.exception.status, 400)
        self.account._call.assert_not_called()

    def test_mfa_login_exposes_only_instructions_not_credentials(self):
        challenge = self.provider.login("13800000000", "123456")
        self.assertTrue(challenge["mfaRequired"])
        self.assertEqual(challenge["directions"][0]["recipient"], "10690000")
        self.assertNotIn("synthetic-cookie-fixture", str(challenge))
        self.assertNotIn("smsCodeKey", challenge)
        self.assertNotIn("encryptUid", challenge)
        self.account._call.assert_not_called()

    def test_mfa_send_never_falsely_claims_sim_sms_sent(self):
        challenge = self.provider.login("13800000000", "123456")
        response = self.provider.mfa_send("13800000000", "123456", challenge["challengeId"])
        self.assertFalse(response["sent"])
        self.assertTrue(response["requiresManualSms"])
        self.assertEqual(response["directions"], challenge["directions"])
        self.account.send_code.assert_not_called()
        self.account.verify_mfa.assert_not_called()

    def test_mfa_verify_pending_is_retryable_and_preserves_challenge(self):
        challenge = self.provider.login("13800000000", "123456")
        response = self.provider.mfa_verify("13800000000", "123456", challenge["challengeId"])
        self.assertTrue(response["pending"])
        self.assertEqual(response["challengeId"], challenge["challengeId"])
        self.assertIn("尚未确认", response["message"])
        self.account.verify_mfa.assert_called_once_with("13800000000", "123456")

    def test_mfa_verify_success_returns_session(self):
        challenge = self.provider.login("13800000000", "123456")
        self.account.verify_mfa.return_value = {"ok": True, "replayed": True}
        response = self.provider.mfa_verify("13800000000", "123456", challenge["challengeId"])
        self.assertTrue(response["loggedIn"])
        self.assertNotIn("mfaRequired", response)

    def test_mfa_wrong_phone_challenge_or_account_never_reaches_sdk_verify(self):
        challenge = self.provider.login("13800000000", "123456")
        for mobile, challenge_id in (("13900000000", challenge["challengeId"]), ("13800000000", "old-challenge")):
            with self.assertRaises(ProviderError) as error:
                self.provider.mfa_verify(mobile, "123456", challenge_id)
            self.assertEqual(error.exception.status, 409)
        self.account._session_identity.return_value = "new-account-identity"
        with self.assertRaises(ProviderError):
            self.provider.mfa_verify("13800000000", "123456", challenge["challengeId"])
        self.account.verify_mfa.assert_not_called()

    def test_mfa_expired_context_never_sends_or_verifies(self):
        challenge = self.provider.login("13800000000", "123456")
        self.mfa_context["at"] = time.time() - 901
        with self.assertRaises(ProviderError) as error:
            self.provider.mfa_send("13800000000", "123456", challenge["challengeId"])
        self.assertEqual(error.exception.code, "MFA_EXPIRED")
        self.account.send_code.assert_not_called()
        self.account.verify_mfa.assert_not_called()

    def test_replay_keeps_original_watch_time_and_ignores_newer_cloud(self):
        watched_at = 1790000000.25
        payload = {"series": {"id": "12345678"}, "episode": 1, "position": 5, "duration": 60,
                   "intent": "replay", "watchedAt": watched_at, "expectedUid": "synthetic-user"}
        self.account.remote_progress.return_value = {"ok": True, "episode": 2, "updatedAt": 1790000001250}
        result = self.provider.progress(payload)
        self.assertTrue(result["skipped"])
        self.account._call.assert_not_called()
        self.account.remote_progress.return_value = {"ok": True, "episode": 1, "updatedAt": 1789999999250, "position": 0}
        self.assertTrue(self.provider.progress(payload)["synced"])
        item = self.account._call.call_args.kwargs["body"]["update_datas"][0]
        self.assertEqual(item["read_timestamp_ms"], 1790000000250)

    def test_live_fractional_position_is_sent_in_milliseconds_through_provider(self):
        payload = {"series": {"id": "12345678", "title": "测试"}, "episode": 2, "position": 27.25,
                   "duration": 60.5, "watchedAt": 1790000000.25, "intent": "active", "expectedUid": "synthetic-user"}
        self.assertTrue(self.provider.progress(payload)["synced"])
        item = self.account._call.call_args.kwargs["body"]["update_datas"][0]
        self.assertEqual(item["current_play_position"], 27250)
        self.assertEqual(item["duration"], 60500)
        self.assertEqual(item["read_timestamp_ms"], 1790000000250)

    def test_replay_compares_mobile_milliseconds_to_desktop_seconds(self):
        payload = {"series": {"id": "12345678"}, "episode": 1, "position": 27.25, "duration": 60.5,
                   "watchedAt": 1790000000.25, "intent": "replay", "expectedUid": "synthetic-user"}
        # Same episode but a newer phone time must prevent an old desktop retry.
        self.account.remote_progress.return_value = {"ok": True, "episode": 1, "updatedAt": 1790000001250, "position": 20000}
        self.assertTrue(self.provider.progress(payload)["skipped"])
        self.account._call.assert_not_called()
        # Same timestamp, further phone position also wins after unit conversion.
        self.account.remote_progress.return_value = {"ok": True, "episode": 1, "updatedAt": 1790000000250, "position": 30000}
        self.assertTrue(self.provider.progress(payload)["skipped"])
        self.account._call.assert_not_called()
        # Earlier timestamp and position permit the preserved desktop retry.
        self.account.remote_progress.return_value = {"ok": True, "episode": 1, "updatedAt": 1789999999250, "position": 20000}
        self.assertTrue(self.provider.progress(payload)["synced"])
        item = self.account._call.call_args.kwargs["body"]["update_datas"][0]
        self.assertEqual(item["current_play_position"], 27250)

    def test_replay_cloud_read_failure_never_writes(self):
        self.account.remote_progress.return_value = {"ok": False, "reason": "read_failed"}
        with self.assertRaises(ProviderError) as error:
            self.provider.progress({"series": {"id": "12345678"}, "episode": 1, "intent": "replay",
                                    "watchedAt": 100000, "expectedUid": "synthetic-user"})
        self.assertEqual(error.exception.code, "CLOUD_READ_FAILED")
        self.account._call.assert_not_called()

    def test_migration_whitelists_session_without_cloud_calls(self):
        self.account.load_session.return_value = {}
        self.provider.import_session({"uid": "synthetic-user", "token": "synthetic-only", "extra_secret": "discard"})
        self.account.save_session.assert_called_once_with({"uid": "synthetic-user", "token": "synthetic-only"})
        self.account._call.assert_not_called()

    def test_migration_accepts_base64_opaque_uid_but_preserves_existing_login(self):
        opaque = "#c1967_" + "Q" * 58 + "+/=="
        self.account.load_session.return_value = {}
        self.provider.import_session({"uid": opaque, "token": "synthetic-only"})
        self.assertEqual(self.account.save_session.call_args.args[0]["uid"], opaque)
        self.account.load_session.return_value = {"uid": "current-user", "token": "synthetic-current"}
        self.account.save_session.reset_mock()
        with self.assertRaises(ProviderError) as error:
            self.provider.import_session({"uid": opaque, "token": "synthetic-only"})
        self.assertEqual(error.exception.status, 409)
        self.account.save_session.assert_not_called()
        self.account._call.assert_not_called()

    @unittest.skipUnless(sys.platform == "win32", "DPAPI requires Windows")
    def test_dpapi_vault_roundtrip_never_writes_plaintext(self):
        path = self.work / "vault.dpapi"
        fixture = {"uid": "synthetic-user", "token": "synthetic-private-token-fixture"}
        vault = SessionVault(path)
        vault.save(fixture)
        self.assertNotIn(fixture["token"].encode(), path.read_bytes())
        self.assertEqual(SessionVault(path).load(), fixture)
        vault.clear()
        self.assertEqual(vault.load(), {})

    def test_source_url_rejects_local_or_credential_urls(self):
        for url in ("http://example.com/file", "https://localhost/file", "https://127.0.0.1/file", "https://u:p@example.com/file"):
            self.assertIsNone(self.provider._media_url(url))
        self.assertEqual(self.provider._media_url("https://cdn.example.com/video.mp4"), "https://cdn.example.com/video.mp4")

    def test_source_cache_retains_active_lease_and_bounds_count(self):
        paths = [self.provider.source_dir / f"test-{index}.mp4" for index in range(10)]
        for path in paths:
            path.write_bytes(b"owned-test-media")
        self.provider._leases[str(paths[0])] = 1
        self.provider._prune_sources()
        self.assertTrue(paths[0].exists())
        self.assertEqual(len(list(self.provider.source_dir.glob("*.mp4"))), 8)


class CacheTests(unittest.TestCase):
    def test_concurrent_calls_share_one_loader(self):
        cache = RequestCache()
        barrier = threading.Barrier(6)
        loader = Mock(side_effect=lambda: (time.sleep(.03), {"value": 1})[1])
        def read(_):
            barrier.wait(timeout=2)
            return cache.get("same", 60, loader)
        with ThreadPoolExecutor(max_workers=6) as pool:
            result = list(pool.map(read, range(6)))
        self.assertEqual(loader.call_count, 1)
        self.assertTrue(all(item == {"value": 1} for item in result))

    def test_failure_is_not_cached(self):
        cache = RequestCache()
        loader = Mock(side_effect=[RuntimeError("temporary"), "recovered"])
        with self.assertRaises(RuntimeError):
            cache.get("same", 60, loader)
        self.assertEqual(cache.get("same", 60, loader), "recovered")


class VendorHistoryPageTests(unittest.TestCase):
    def setUp(self):
        # Execute the real leaf with HTTP/session dependencies injected. Importing
        # the whole vendor SDK would require an unrelated signer/config runtime.
        source = Path(__file__).resolve().parents[1] / "vendor" / "desktop_account.py"
        parsed = ast.parse(source.read_text(encoding="utf-8"))
        function = next(node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == "remote_history_page")
        self.call = Mock()
        self.changed = Mock(return_value=False)
        import hashlib
        namespace = {"_call": self.call, "_json": lambda value: value, "_account_changed": self.changed,
                     "load_session": lambda: {"uid": "fixture-user", "cookie": "fixture-cookie"}, "hashlib": hashlib}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
        self.page = namespace["remote_history_page"]

    def test_real_leaf_keeps_all_rows_and_advances_without_truncation(self):
        rows = ProviderTests.raw_history(0, 500)
        self.call.return_value = {"code": 0, "data": {"data_list": rows, "total": 650}}
        response = self.page(offset=0, limit=100)
        self.assertEqual(len(response["items"]), 500)
        self.assertEqual(response["nextOffset"], 500)
        self.assertTrue(response["hasMore"])
        self.call.assert_called_once()
        self.assertEqual(self.call.call_args.kwargs["extra"]["offset"], "0")
        self.assertEqual(self.call.call_args.kwargs["extra"]["limit"], "100")
        self.assertNotIn("fixture-cookie", str(response))

    def test_real_leaf_passes_following_offset_and_detects_server_end(self):
        self.call.return_value = {"code": 0, "data": {"data_list": ProviderTests.raw_history(500, 150), "total": 650}}
        response = self.page(offset=500, limit=100)
        self.assertEqual(response["nextOffset"], 650)
        self.assertFalse(response["hasMore"])
        self.assertEqual(self.call.call_args.kwargs["extra"]["offset"], "500")

    def test_real_leaf_rejects_changed_session_and_malformed_history(self):
        self.call.return_value = {"code": 0, "data": {"data_list": []}}
        self.changed.return_value = True
        self.assertTrue(self.page()["accountChanged"])
        self.changed.return_value = False
        self.call.return_value = {"code": 0, "data": {"data_list": "invalid"}}
        self.assertFalse(self.page()["ok"])

    def test_real_leaf_parameter_validation_precedes_upstream_request(self):
        self.assertFalse(self.page(offset=-1)["ok"])
        self.assertFalse(self.page(limit=0)["ok"])
        self.call.assert_not_called()


class CatalogCacheTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parent / ".work"
        root.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=root, prefix="catalog-")
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "catalog-cache.json"
        self.row = {"id": "12345678", "title": "已加载的剧", "cover": "https://cdn.example.com/poster.jpg", "totalEpisodes": 10}

    def cache(self, **kwargs):
        cache = CatalogCache(self.path, **kwargs)
        self.addCleanup(cache.close)
        return cache

    def saved(self, at):
        self.path.write_text(json.dumps({"schema": 1, "entries": {"discover:short_play": {"at": at, "items": [self.row]}}}), encoding="utf-8")

    def test_restart_returns_validated_public_cache_without_network(self):
        first = self.cache()
        self.assertFalse(first.get("discover:short_play", lambda: [self.row])["cached"])
        loader = Mock(side_effect=RuntimeError("network disconnected"))
        second = self.cache()
        response = second.get("discover:short_play", loader)
        self.assertTrue(response["cached"])
        self.assertEqual(response["items"][0]["title"], self.row["title"])
        loader.assert_not_called()

    def test_stale_response_is_immediate_and_background_update_is_single(self):
        self.saved(time.time() - 180)
        cache = self.cache()
        entered, release, completed = threading.Event(), threading.Event(), threading.Event()
        def update():
            entered.set()
            release.wait(3)
            completed.set()
            return [{**self.row, "title": "新片单"}]
        loader = Mock(side_effect=update)
        try:
            first = cache.get("discover:short_play", loader)
            self.assertTrue(entered.wait(1))
            second = cache.get("discover:short_play", loader)
            self.assertEqual(first["items"][0]["title"], self.row["title"])
            self.assertTrue(first["stale"] and second["updating"])
            self.assertEqual(loader.call_count, 1)
        finally:
            release.set()
        self.assertTrue(completed.wait(2))
        # A manual refresh waits for the existing request and returns its result.
        response = cache.get("discover:short_play", loader, refresh=True)
        self.assertEqual(response["items"][0]["title"], "新片单")

    def test_force_refresh_failure_preserves_content_and_warns(self):
        cache = self.cache()
        cache.get("discover:short_play", lambda: [self.row])
        response = cache.get("discover:short_play", Mock(side_effect=RuntimeError("timeout")), refresh=True)
        self.assertEqual(response["items"][0]["title"], self.row["title"])
        self.assertTrue(response["cached"])
        self.assertIn("保留", response["warning"])

    def test_manual_refresh_replaces_previous_content(self):
        cache = self.cache()
        cache.get("discover:short_play", lambda: [self.row])
        response = cache.get("discover:short_play", lambda: [{**self.row, "title": "最新片单"}], refresh=True)
        self.assertFalse(response["cached"])
        self.assertEqual(response["items"][0]["title"], "最新片单")

    def test_corrupt_expired_or_private_cache_entries_are_discarded(self):
        self.path.write_text("broken-json", encoding="utf-8")
        self.assertFalse(self.cache().values)
        self.saved(time.time() - 4 * 86400)
        self.assertFalse(self.cache().values)
        self.path.write_text(json.dumps({"schema": 1, "entries": {"recommend:account-id": {"at": time.time(), "items": [self.row]}}}), encoding="utf-8")
        self.assertFalse(self.cache().values)

    def test_cache_omits_credentials_and_has_finite_capacity(self):
        cache = self.cache(capacity=2)
        for genre in ("short_play", "comic_series", "ai_series"):
            cache.get("discover:" + genre, lambda: [{**self.row, "cookie": "fixture-secret", "token": "fixture-secret"}])
        self.assertEqual(len(cache.values), 2)
        raw = self.path.read_text(encoding="utf-8")
        self.assertNotIn("fixture-secret", raw)
        self.assertNotIn('"cookie"', raw)
        self.assertNotIn('"token"', raw)

    def test_concurrent_initial_calls_fetch_once(self):
        cache = self.cache()
        entered, release = threading.Event(), threading.Event()
        def load():
            entered.set()
            release.wait(3)
            return [self.row]
        loader = Mock(side_effect=load)
        with ThreadPoolExecutor(max_workers=5) as pool:
            futures = [pool.submit(cache.get, "discover:short_play", loader) for _ in range(5)]
            try:
                self.assertTrue(entered.wait(1))
            finally:
                release.set()
            self.assertTrue(all(future.result(timeout=3)["items"] for future in futures))
        self.assertEqual(loader.call_count, 1)

    def test_empty_refresh_keeps_last_list(self):
        cache = self.cache()
        cache.get("discover:short_play", lambda: [self.row])
        response = cache.get("discover:short_play", lambda: [], refresh=True)
        self.assertTrue(response["items"])
        self.assertIn("warning", response)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.token = "a" * 64
        provider = types.SimpleNamespace(session=lambda: {"loggedIn": False, "uid": "", "nickname": "", "avatar": "", "mobile": ""},
                                         search=lambda q: {"items": []})
        self.app = create_app(provider, self.token)
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.headers = {"Authorization": "Bearer " + self.token}

    def test_bearer_required_even_for_health(self):
        self.assertEqual(self.client.get("/health").status_code, 401)
        metadata = Path(__file__).resolve().parents[2] / "package.json"
        expected = json.loads(metadata.read_text(encoding="utf-8"))["version"]
        self.assertEqual(self.client.get("/health", headers=self.headers).json()["version"], expected)

    def test_query_token_is_only_allowed_for_media_routes(self):
        self.assertEqual(self.client.get("/health?token=" + self.token).status_code, 401)
        @self.app.get("/media/probe")
        def probe():
            return {"ok": True}
        self.assertEqual(self.client.get("/media/probe?token=" + self.token).status_code, 401)

    def test_media_url_capability_cannot_access_account_or_session_writes(self):
        media_token = "b" * 64
        manager = types.SimpleNamespace(token=media_token, read_file=Mock(return_value=b"media-file"))
        app = create_app(types.SimpleNamespace(session=lambda: {"loggedIn": False}), self.token, manager)
        client = TestClient(app, raise_server_exceptions=False)
        media_path = "/media/session/test-session/seg000001.m4s"
        response = client.get(media_path + "?token=" + media_token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b"media-file")
        for route in ("/account/session", "/media/cache", "/media/session/test-session"):
            self.assertEqual(client.get(route + "?token=" + media_token).status_code, 401)
            self.assertEqual(client.get(route, headers={"Authorization": "Bearer " + media_token}).status_code, 401)
        for route in ("/account/import", "/media/session", "/media/cache/clear"):
            self.assertEqual(client.post(route + "?token=" + media_token, json={}).status_code, 401)
            self.assertEqual(client.post(route, headers={"Authorization": "Bearer " + media_token}, json={}).status_code, 401)
        self.assertEqual(client.delete("/media/session/test-session?token=" + media_token).status_code, 401)
        self.assertEqual(client.get(media_path + "?token=" + self.token).status_code, 401)

    def test_validation_has_uniform_error_without_input_echo(self):
        response = self.client.get("/catalog/comments?seriesId=12345678&episode=private-input", headers=self.headers)
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.json()["error"]["code"], "INPUT_INVALID")
        self.assertNotIn("private-input", response.text)

    def test_logout_requires_authorization(self):
        self.assertEqual(self.client.post("/account/logout").status_code, 401)

    def test_home_refresh_reaches_provider(self):
        provider = types.SimpleNamespace(home=Mock(return_value={"items": []}))
        client = TestClient(create_app(provider, self.token))
        self.assertEqual(client.get("/catalog/home?refresh=true", headers=self.headers).status_code, 200)
        provider.home.assert_called_once_with("short_play", "", "discover", refresh=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
