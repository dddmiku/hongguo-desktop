"""QR protocol and account handover contracts, using synthetic credentials only."""
from concurrent.futures import ThreadPoolExecutor
import base64
from pathlib import Path
import sys
import threading
import types
import unittest
from unittest.mock import Mock

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from qr_login import (OfficialQrTransport, QrLoginError, QrLoginManager, ORIGIN,
                      POLL_SECONDS, WEB_AID, _data, _image, _trusted_redirect, verify_mobile_session)


IMAGE = "data:image/jpeg;base64," + base64.b64encode(b"\xff\xd8\xffsynthetic-image").decode("ascii")
SECOND_IMAGE = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\nsynthetic-image").decode("ascii")


def response(payload, status=200, headers=None):
    return types.SimpleNamespace(status_code=status, content=b"synthetic-response", json=lambda: payload, headers=headers or {})


class FakeTransport:
    def __init__(self):
        self.create = Mock(return_value={"token": "synthetic-qr-context", "imageDataUrl": IMAGE, "expiresAt": 1060})
        self.poll = Mock(return_value={"status": "new"})
        self.candidate = Mock(return_value={"cookie": "sessionid=synthetic-login-cookie", "token": ""})
        self.close = Mock()


class QrLoginTests(unittest.TestCase):
    def setUp(self):
        self.now = 10
        self.identity = "synthetic-original-identity"
        self.transport = FakeTransport()
        def account_read(method, path, **kwargs):
            if path == "/reading/user/info/v":
                return {"code": 0, "data": {"user_id": "synthetic-mobile-user", "user_name": "测试用户"}}
            if path.endswith("read_history/list/v"):
                return {"code": 0, "data": {"data_list": []}}
            if path.endswith("bookshelf/video/list/v"):
                return {"code": 0, "data": {"video_shelf_info": []}}
            raise AssertionError("unexpected endpoint")
        self.account = types.SimpleNamespace(_call=Mock(side_effect=account_read), _json=lambda value: value,
                                            save_session=Mock())
        self.commit = Mock(return_value={"loggedIn": True, "uid": "synthetic-public-uid", "nickname": "测试用户"})
        self.manager = QrLoginManager(self.account, self.commit, lambda: self.identity, lambda: self.transport,
                                      clock=lambda: self.now, wall_clock=lambda: 1000)
        self.addCleanup(self.manager.close)

    def begin(self):
        created = self.manager.create()
        self.now += POLL_SECONDS
        return created

    def test_created_ui_context_contains_image_and_no_official_credentials(self):
        result = self.begin()
        self.assertEqual(result["status"], "waiting")
        self.assertEqual(result["imageDataUrl"], IMAGE)
        self.assertEqual(result["expiresAt"], 1060)
        self.assertNotIn("token", result)
        self.assertNotIn("cookie", result)
        self.assertNotIn("synthetic-qr-context", repr(result))
        self.account._call.assert_not_called()
        self.commit.assert_not_called()

    def test_short_network_failure_retains_attempt_for_the_next_poll(self):
        created=self.begin()
        self.transport.poll.side_effect=[QrLoginError('QR_NETWORK','暂时无法连接'),{'status':'new'}]
        first=self.manager.status(created['id'])
        self.assertEqual(first['status'],'waiting');self.assertNotIn('error',first)
        self.transport.close.assert_not_called();self.now+=POLL_SECONDS
        second=self.manager.status(created['id'])
        self.assertEqual(second['status'],'waiting');self.assertEqual(self.transport.poll.call_count,2)

    def test_scanned_requires_phone_confirmation_and_never_commits(self):
        created = self.begin()
        self.transport.poll.return_value = {"status": "scanned"}
        result = self.manager.status(created["id"])
        self.assertEqual(result["status"], "scanned")
        self.transport.candidate.assert_not_called()
        self.commit.assert_not_called()

    def test_confirmation_checks_real_mobile_identity_history_and_shelf_before_commit(self):
        created = self.begin()
        self.transport.poll.return_value = {"status": "confirmed", "redirect_url": "/passport/web/scan_login/?ticket=synthetic"}
        def commit(candidate, identity):
            self.assertEqual(self.account._call.call_count, 3)
            self.assertEqual(candidate["uid"], "synthetic-mobile-user")
            self.assertEqual(identity, self.identity)
            return {"loggedIn": True, "uid": "synthetic-public-uid"}
        self.commit.side_effect = commit
        result = self.manager.status(created["id"])
        self.assertEqual(result["status"], "confirmed")
        self.assertTrue(result["session"]["loggedIn"])
        self.assertNotIn("cookie", repr(result))
        self.commit.assert_called_once()
        self.account.save_session.assert_not_called()
        self.assertEqual(self.manager._attempt.context, {})
        self.transport.close.assert_called()
        self.assertEqual(self.manager.status(created["id"])["status"], "confirmed")
        self.assertEqual(self.transport.poll.call_count, 1)

    def test_web_only_account_cannot_replace_current_mobile_session(self):
        created = self.begin()
        self.transport.poll.return_value = {"status": "3"}
        self.account._call.side_effect = lambda *_args, **_kwargs: {"code": 401, "data": {}}
        result = self.manager.status(created["id"])
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "QR_MOBILE_SESSION_UNAVAILABLE")
        self.commit.assert_not_called()
        self.assertEqual(self.manager._attempt.context, {})

    def test_failed_history_or_shelf_blocks_success(self):
        for failing in ("read_history/list/v", "bookshelf/video/list/v"):
            with self.subTest(endpoint=failing):
                original_read = self.account._call.side_effect
                self.account._call.side_effect = lambda method, path, **kw: ({"code": 401, "data": {}}
                    if path.endswith(failing) else original_read(method, path, **kw))
                with self.assertRaises(QrLoginError) as caught:
                    verify_mobile_session(self.account, {"cookie": "sessionid=synthetic-cookie"})
                self.assertEqual(caught.exception.code, "QR_MOBILE_SESSION_UNAVAILABLE")
                self.account._call.side_effect = original_read
        self.commit.assert_not_called()

    def test_guest_profile_cannot_be_mistaken_for_mobile_account(self):
        for user in ({"user_id": "0"}, {"user_id": "synthetic-user", "is_login": False}):
            with self.subTest(user=user):
                self.account._call.side_effect = lambda *_args, **_kwargs: {"code": 0, "data": user}
                with self.assertRaises(QrLoginError) as error:
                    verify_mobile_session(self.account, {"cookie": "sessionid=synthetic-cookie"})
                self.assertEqual(error.exception.code, "QR_MOBILE_SESSION_UNAVAILABLE")

    def test_remote_exception_values_do_not_enter_ui_or_error_message(self):
        created = self.begin()
        self.transport.poll.side_effect = RuntimeError("token=synthetic-do-not-output")
        result = self.manager.status(created["id"])
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("synthetic-do-not-output", repr(result))

    def test_polling_is_throttled(self):
        result = self.manager.create()
        self.manager.status(result["id"])
        self.transport.poll.assert_not_called()
        self.now += POLL_SECONDS
        self.manager.status(result["id"])
        self.manager.status(result["id"])
        self.transport.poll.assert_called_once()

    def test_expiration_does_not_poll_upstream_or_commit(self):
        result = self.begin()
        self.now = 71
        self.assertEqual(self.manager.status(result["id"])["status"], "expired")
        self.transport.poll.assert_not_called()
        self.commit.assert_not_called()

    def test_cancel_clears_private_context_and_prevents_confirmation(self):
        result = self.begin()
        self.assertEqual(self.manager.cancel(result["id"])["status"], "cancelled")
        self.assertEqual(self.manager._attempt.context, {})
        self.assertEqual(self.manager.status(result["id"])["status"], "cancelled")
        self.transport.poll.assert_not_called()

    def test_account_change_cancels_pending_login(self):
        result = self.begin()
        self.identity = "synthetic-replacement-identity"
        self.assertEqual(self.manager.status(result["id"])["status"], "cancelled")
        self.transport.poll.assert_not_called()
        self.commit.assert_not_called()

    def test_account_change_during_create_does_not_expose_stale_qr_image(self):
        def create():
            self.identity = "synthetic-new-identity"
            return {"token": "synthetic-qr-context", "imageDataUrl": IMAGE, "expiresAt": 1060}
        self.transport.create.side_effect = create
        result = self.manager.create()
        self.assertEqual(result["status"], "cancelled")
        self.assertNotIn("imageDataUrl", result)

    def test_invalid_or_replaced_attempt_ids_are_rejected(self):
        first = self.begin()
        second_transport = FakeTransport()
        self.manager.transport_factory = lambda: second_transport
        second = self.manager.create()
        self.assertNotEqual(first["id"], second["id"])
        self.transport.close.assert_called()
        for id, code in ((first["id"], "QR_NOT_FOUND"), ("not-an-id", "INPUT_INVALID")):
            with self.assertRaises(QrLoginError) as error:
                self.manager.status(id)
            self.assertEqual(error.exception.code, code)

    def test_rotated_qr_image_updates_private_token_without_exposing_it(self):
        result = self.begin()
        self.transport.poll.return_value = {"status": "4", "token": "synthetic-rotated-token", "qrcode": SECOND_IMAGE}
        refreshed = self.manager.status(result["id"])
        self.assertEqual(refreshed["imageDataUrl"], SECOND_IMAGE)
        self.assertNotIn("synthetic-rotated-token", repr(refreshed))
        self.assertEqual(self.manager._attempt.context["token"], "synthetic-rotated-token")

    def test_upstream_expiration_and_cancellation_are_terminal(self):
        for upstream, expected in (("expired", "expired"), ("5", "expired"), ("rejected", "cancelled")):
            with self.subTest(upstream=upstream):
                result = self.begin()
                self.transport.poll.return_value = {"status": upstream}
                self.assertEqual(self.manager.status(result["id"])["status"], expected)
                self.now += POLL_SECONDS
        self.commit.assert_not_called()

    def test_cancel_during_inflight_confirmation_never_saves_the_account(self):
        result = self.begin()
        entered, release = threading.Event(), threading.Event()
        def poll(context):
            entered.set()
            self.assertTrue(release.wait(3))
            return {"status": "confirmed"}
        self.transport.poll.side_effect = poll
        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(self.manager.status, result["id"])
            self.assertTrue(entered.wait(3))
            self.assertEqual(self.manager.cancel(result["id"])["status"], "cancelled")
            release.set()
            self.assertEqual(pending.result(timeout=3)["status"], "cancelled")
        self.commit.assert_not_called()
        self.account._call.assert_not_called()

    def test_close_releases_context_and_rejects_new_attempts(self):
        self.begin()
        self.manager.close()
        self.assertEqual(self.manager._attempt.context, {})
        with self.assertRaises(QrLoginError) as error:
            self.manager.create()
        self.assertEqual(error.exception.code, "SERVICE_STOPPING")


class QrTransportTests(unittest.TestCase):
    def setUp(self):
        self.http = types.SimpleNamespace(headers={}, cookies=requests.cookies.RequestsCookieJar(), get=Mock(), close=Mock())
        self.transport = OfficialQrTransport(self.http)
        self.addCleanup(self.transport.close)

    def test_official_aid_and_poll_context_are_consistent(self):
        self.http.get.side_effect = [response({"message": "success", "data": {
            "error_code": 0, "token": "synthetic-qr-context", "qrcode": IMAGE, "expire_time": 1060}}),
            response({"message": "success", "data": {"error_code": 0, "status": "new"}})]
        context = self.transport.create()
        self.assertEqual(self.transport.poll(context)["status"], "new")
        self.assertEqual(WEB_AID, "513755")
        for call in self.http.get.call_args_list:
            self.assertEqual(call.kwargs["params"]["aid"], WEB_AID)
            self.assertFalse(call.kwargs["allow_redirects"])
        self.assertEqual(self.http.get.call_args_list[-1].kwargs["params"]["token"], "synthetic-qr-context")

    def test_redirect_cookie_is_a_candidate_and_not_a_completed_login(self):
        self.http.cookies.set("sessionid", "synthetic-auth", domain=".hongguoduanju.com")
        self.http.cookies.set("passport_csrf_token", "synthetic-csrf", domain=".hongguoduanju.com")
        self.http.cookies.set("unrelated", "synthetic-tracking", domain=".hongguoduanju.com")
        self.http.cookies.set("sid_tt", "synthetic-foreign", domain="untrusted.example")
        self.http.get.side_effect = [response({},302,{"location":"/passport/web/scan_login/?ticket=synthetic-next"}), response({})]
        candidate = self.transport.candidate({"redirect_url": "/passport/web/scan_login/?ticket=synthetic-first"})
        self.assertIn("sessionid=synthetic-auth", candidate["cookie"])
        self.assertNotIn("synthetic-tracking", candidate["cookie"])
        self.assertNotIn("synthetic-foreign", candidate["cookie"])
        self.assertNotIn("uid", candidate)
        self.assertEqual(self.http.get.call_count, 2)

    def test_csrf_cookie_alone_cannot_be_used_as_login(self):
        self.http.cookies.set("passport_csrf_token", "synthetic-csrf", domain=".hongguoduanju.com")
        with self.assertRaises(QrLoginError) as error:
            self.transport.candidate({})
        self.assertEqual(error.exception.code, "QR_INCOMPLETE_SESSION")

    def test_untrusted_redirects_are_not_requested(self):
        for url in ("http://hongguoduanju.com/passport/web/scan_login/", "https://evil.example/passport/web/scan_login/",
                    "https://hongguoduanju.com.evil.example/passport/web/scan_login/", "https://hongguoduanju.com:8080/passport/",
                    "https://user:synthetic@hongguoduanju.com/passport/", "https://hongguoduanju.com/api/delete"):
            with self.subTest(url=url), self.assertRaises(QrLoginError):
                self.transport.candidate({"redirect_url":url})
        self.http.get.assert_not_called()

    def test_every_redirect_hop_is_validated_before_request(self):
        self.http.get.return_value = response({},302,{"location":"https://evil.example/passport/"})
        with self.assertRaises(QrLoginError):
            self.transport.candidate({"redirect_url":"/passport/web/scan_login/?ticket=synthetic"})
        self.http.get.assert_called_once()

    def test_token_url_in_network_exception_is_redacted(self):
        self.http.get.side_effect = requests.ConnectionError("https://hongguoduanju.com/?token=synthetic-secret")
        with self.assertRaises(QrLoginError) as error:
            self.transport.create()
        self.assertNotIn("synthetic-secret", str(error.exception))

    def test_captcha_and_business_errors_have_fixed_messages(self):
        for payload, expected in (({"data":{"error_code":0,"captcha":"synthetic-captcha"}},"QR_VERIFICATION_REQUIRED"),
                                  ({"data":{"error_code":2035,"description":"synthetic-sensitive"}},"QR_EXPIRED"),
                                  ({"data":{"error_code":999,"description":"synthetic-sensitive"}},"QR_UPSTREAM_REJECTED")):
            with self.subTest(expected=expected), self.assertRaises(QrLoginError) as error:
                _data(response(payload))
            self.assertEqual(error.exception.code,expected)
            self.assertNotIn("synthetic-sensitive", str(error.exception))

    def test_qr_image_must_be_bounded_raster_base64(self):
        self.assertEqual(_image(IMAGE),IMAGE)
        self.assertEqual(_image(SECOND_IMAGE),SECOND_IMAGE)
        for bad in ("https://evil.example/image", "data:image/svg+xml;base64,"+base64.b64encode(b"<svg/>").decode(),
                    "not-valid-base64", "A"*1048577):
            with self.subTest(bad=bad[:30]), self.assertRaises(QrLoginError):
                _image(bad)


if __name__ == "__main__":
    unittest.main()
