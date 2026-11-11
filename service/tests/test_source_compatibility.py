"""Exercise source preparation when the upstream model offers only ByteVC2."""
import base64
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "service"))
from provider import Provider, ProviderError, decode_playback_url


# Fixed synthetic envelope independently checked against the native decoder.
_SEED = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8='
_ENCRYPTED_URL = 'qAABAH8hYpJzWAiQddxcgovhJDtHfwXsEiCR4Q5kdxLtkElfqZbEqXNnJxjGAJXg/qJTxg=='


class CompatibilityTests(unittest.TestCase):
    def setUp(self):
        work = ROOT / "_work" / "source-compatibility-tests"
        work.mkdir(parents=True, exist_ok=True)
        temporary = tempfile.TemporaryDirectory(dir=work)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.fallback = "https://fplay.bytedance.com/?codec_type=4&force_fids=fixture&ssl=1"
        self.track = {"video_meta": {"definition": "1080p", "codec_type": "bytevc2"},
                      "main_url": "https://cdn.example.com/unsupported.mp4",
                      "_hq_fallback_api": {"fallback_api": self.fallback}}
        self.response = Mock()
        self.response.__enter__ = Mock(return_value=self.response)
        self.response.__exit__ = Mock(return_value=False)
        self.response.status_code = 200
        self.response.content = b"fixture-model"
        self.model = {"code": 0, "video_info": {"code": 0, "data": {"video_list": {
            "video_1": {"codec_type": "h265", "definition": "1080p", "encrypt": False,
                        "main_url": base64.b64encode(b"https://cdn.example.com/compatible.mp4").decode()}}}}}
        self.response.json = Mock(side_effect=lambda: self.model)
        self.sdk = types.SimpleNamespace(
            get_episodes=Mock(return_value=({"id": "12345678", "title": "测试短剧"},
                [{"index": 4, "vid": "23456789", "duration": 80}])),
            get_video_tracks=Mock(return_value={"23456789": [self.track]}),
            http_request=Mock(return_value=self.response))
        self.provider = Provider(self.root, self.sdk)
        self.addCleanup(self.provider.close)
        self.provider.source_downloader.download = Mock(side_effect=self.download)

    @staticmethod
    def download(url, output, cancelled):
        cancelled()
        output.write_bytes(b"fixture-playable-source")
        return output.stat().st_size

    def test_all_bytevc2_tracks_negotiate_a_standard_source(self):
        source = self.provider.source("12345678", 4)
        self.assertEqual(source.read_bytes(), b"fixture-playable-source")
        call = self.sdk.http_request.call_args
        query = parse_qs(urlsplit(call.args[1]).query)
        self.assertEqual(query["codec_type"], ["1"])
        self.assertNotIn("force_fids", query)
        self.assertEqual(query["ssl"], ["1"])
        self.assertEqual(call.kwargs["allow_redirects"], False)
        self.provider.source_downloader.download.assert_called_once()
        self.assertEqual(self.provider.source_downloader.download.call_args.args[0], "https://cdn.example.com/compatible.mp4")

    def test_already_supported_model_does_not_request_fallback(self):
        self.track["video_meta"]["codec_type"] = "hevc"
        self.provider.source("12345678", 4)
        self.sdk.http_request.assert_not_called()

    def test_extra_official_backups_are_decoded_before_downloader_failover(self):
        row = self.model["video_info"]["data"]["video_list"]["video_1"]
        self.model["video_info"]["data"]["key_seed"] = _SEED
        row["main_url"] = base64.b64encode(b"https://cdn.example.com/expired-main.mp4").decode()
        row["backup_url_2"] = _ENCRYPTED_URL
        def download(url, output, cancelled):
            if url.endswith('/expired-main.mp4'):
                raise OSError('Controlled unavailable primary CDN')
            return self.download(url, output, cancelled)
        self.provider.source_downloader.download.side_effect = download
        source = self.provider.source("12345678", 4)
        self.assertEqual(source.read_bytes(), b"fixture-playable-source")
        self.assertEqual(self.provider.source_downloader.download.call_args.args[0],
                         "https://cdn.example.com/compatible.mp4")

    def test_encrypted_official_fallback_urls_are_decoded_before_download(self):
        self.model["video_info"]["data"]["key_seed"] = _SEED
        self.model["video_info"]["data"]["video_list"]["video_1"]["main_url"] = _ENCRYPTED_URL
        self.provider.source("12345678", 4)
        self.assertEqual(self.provider.source_downloader.download.call_args.args[0], "https://cdn.example.com/compatible.mp4")

    def test_compatible_tracks_are_shared_when_the_user_changes_quality(self):
        first = self.provider.source("12345678", 4, "1080p")
        self.provider.release_source(first)
        second = self.provider.source("12345678", 4, "720p")
        self.provider.release_source(second)
        self.assertEqual(self.sdk.http_request.call_count, 1)
        self.assertEqual(self.provider.source_downloader.download.call_count, 2)

    def test_cancelled_preparation_never_contacts_fallback(self):
        with self.assertRaises(ProviderError) as caught:
            self.provider.source("12345678", 4, cancelled=lambda: True)
        self.assertEqual(caught.exception.code, "MEDIA_CANCELLED")
        self.sdk.http_request.assert_not_called()

    def test_untrusted_or_missing_fallback_never_fetches_another_host(self):
        for value in (None, "http://fplay.bytedance.com/model", "https://localhost/model", "https://127.0.0.1/model", "https://evil.example/model"):
            self.track["_hq_fallback_api"] = value
            with self.assertRaises(ProviderError) as caught:
                self.provider.source("12345678", 4)
            self.assertEqual(caught.exception.code, "MEDIA_CODEC_UNSUPPORTED")
        self.sdk.http_request.assert_not_called()

    def test_fallback_failure_does_not_cache_failure_or_download_bytevc2(self):
        self.response.json.side_effect = [ValueError("fixture upstream response"), self.model]
        with self.assertRaises(ProviderError):
            self.provider.source("12345678", 4)
        self.provider.source_downloader.download.assert_not_called()
        self.assertTrue(self.provider.source("12345678", 4).exists())
        self.assertEqual(self.sdk.http_request.call_count, 2)

    def test_fallback_that_still_offers_bytevc2_is_rejected(self):
        self.model["video_info"]["data"]["video_list"]["video_1"]["codec_type"] = "bytevc2"
        with self.assertRaises(ProviderError) as caught:
            self.provider.source("12345678", 4)
        self.assertEqual(caught.exception.code, "MEDIA_CODEC_UNSUPPORTED")
        self.provider.source_downloader.download.assert_not_called()


class PlaybackUrlTests(unittest.TestCase):
    def test_native_verified_envelope_decodes_exactly(self):
        self.assertEqual(decode_playback_url(_ENCRYPTED_URL, _SEED), "https://cdn.example.com/compatible.mp4")
        self.assertEqual(decode_playback_url("\n" + _ENCRYPTED_URL + "\n", _SEED), "https://cdn.example.com/compatible.mp4")

    def test_bad_envelopes_and_seed_are_rejected_without_exposing_values(self):
        cipher = base64.b64decode(_ENCRYPTED_URL)
        for value, seed in ((None, _SEED), (_ENCRYPTED_URL, None), ("not base64", _SEED),
                            (_ENCRYPTED_URL, "bad seed"), (base64.b64encode(b"\x00" + cipher[1:]).decode(), _SEED),
                            (base64.b64encode(cipher[:2] + b"\x02\x00" + cipher[4:]).decode(), _SEED),
                            (base64.b64encode(cipher[:-1]).decode(), _SEED),
                            (base64.b64encode(cipher[:-1] + bytes([cipher[-1] ^ 1])).decode(), _SEED)):
            self.assertIsNone(decode_playback_url(value, seed))


if __name__ == "__main__":
    unittest.main()
