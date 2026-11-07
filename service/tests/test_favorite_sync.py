import unittest
from unittest.mock import Mock
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from favorite_sync import set_favorite


class FavoriteSyncTest(unittest.TestCase):
    def test_already_saved_never_writes_again(self):
        write = Mock()
        self.assertEqual(set_favorite("12345678", True, lambda: {"ok": True, "items": [{"seriesId": "12345678"}]}, write), {"synced": True, "favorite": True})
        write.assert_not_called()

    def test_failed_write_with_delayed_success_is_read_back(self):
        read = Mock(side_effect=[{"ok": True, "items": []}, {"ok": True, "items": []}, {"ok": True, "items": [{"seriesId": "12345678"}]}])
        write = Mock(return_value={"ok": False, "code": 101144})
        self.assertTrue(set_favorite("12345678", True, read, write, lambda _: None)["favorite"])
        write.assert_called_once()

    def test_failure_remains_visible_and_writes_are_not_retried(self):
        write = Mock(return_value={"ok": False, "code": 101144})
        with self.assertRaisesRegex(ValueError, "101144"):
            set_favorite("12345678", True, lambda: {"ok": True, "items": []}, write, lambda _: None)
        write.assert_called_once()

    def test_cannot_read_state_does_not_mutate(self):
        write = Mock()
        with self.assertRaisesRegex(ValueError, "收藏状态"):
            set_favorite("12345678", True, lambda: {"ok": False}, write)
        write.assert_not_called()

    def test_provider_keeps_business_error_in_ui_response(self):
        import threading
        from provider import Provider, ProviderError
        provider = object.__new__(Provider)
        provider._closed = threading.Event()
        provider._write_lock = threading.Lock()
        provider._expect_uid = lambda _: None
        provider.cache = Mock()
        provider.account = Mock()
        provider.account.remote_favorites.return_value = {"ok": True, "items": []}
        provider.account.set_favorite.return_value = {"ok": False, "code": 101144}
        from unittest.mock import patch
        with patch("favorite_sync.time.sleep"), self.assertRaises(ProviderError) as error:
            provider.favorite("12345678", True)
        self.assertEqual(error.exception.code, "FAVORITE_FAILED")
        self.assertIn("101144", str(error.exception))
        provider.account.set_favorite.assert_called_once()
