"""Offline gateway/provider contracts; all account fixtures are synthetic."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sys
import threading
import time
import types
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient
from gateway import create_app
from provider import Provider, ProviderError, RequestCache, SessionVault, normalize_series


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(__file__).resolve().parent / ".work" / self._testMethodName
        self.work.mkdir(parents=True, exist_ok=True)
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
        self.assertEqual(body["current_play_position"], 10)

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
        payload = {"series": {"id": "12345678"}, "episode": 1, "position": 5, "duration": 60,
                   "intent": "replay", "watchedAt": 100000, "expectedUid": "synthetic-user"}
        self.account.remote_progress.return_value = {"ok": True, "episode": 2, "updatedAt": 200000}
        result = self.provider.progress(payload)
        self.assertTrue(result["skipped"])
        self.account._call.assert_not_called()
        self.account.remote_progress.return_value = {"ok": True, "episode": 1, "updatedAt": 50000, "position": 0}
        self.assertTrue(self.provider.progress(payload)["synced"])
        item = self.account._call.call_args.kwargs["body"]["update_datas"][0]
        self.assertEqual(item["read_timestamp_ms"], 100000)

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
        self.assertEqual(self.client.get("/health", headers=self.headers).json()["version"], "1.0.0")

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


if __name__ == "__main__":
    unittest.main(verbosity=2)
