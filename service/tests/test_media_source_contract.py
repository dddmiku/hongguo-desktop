"""Source fallback contracts with real SDK control flow and offline physical-HTTP counting.

No user profile, credentials, remote HTTP, signature service, decoder or runtime edits.
These are controlled failure fixtures, not a claim about the live upstream cause.
"""
import ast
import copy
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
from urllib.parse import urlsplit

import gzip
import hashlib
import requests

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "service"))
from provider import Provider, ProviderError
from vendor.safeguards import AuthExpiredError, RiskControlError
from web_search import OfficialWebSearch, WebPlaybackError

SERIES, EPISODE, VID = "12345678", 175, "23456789"
# Four official contracts, one host each, and at most one fresh source round.
MAX_SOURCE_MODEL_HTTP = 8


def playable_track(codec="h264", address="https://cdn.example/source-contract.mp4"):
    return {"video_meta": {"definition": "1080p", "codec_type": codec},
            "encrypt_info": {"encrypt": False}, "main_url": address}


class OfflineResponse:
    status_code = 200
    text = ""
    content = b""

    def __init__(self, payload=None):
        self.payload = payload
        self.content = b"" if payload is None else json.dumps(payload).encode()

    def json(self):
        if self.payload is None:
            raise ValueError("controlled empty HTTP 200")
        return copy.deepcopy(self.payload)


def offline_sdk(http):
    """Load only reachable function/class definitions; never execute SDK defaults/imports."""
    source = ROOT / "service/vendor/hongguo.py"
    tree = ast.parse(source.read_text(encoding="utf-8-sig"))
    definitions = {node.name: node for node in tree.body
                   if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
    hosts = ["https://model-" + str(index) + ".example" for index in range(8)]
    cache = {}
    signer = Mock(return_value={})
    safeguard = types.SimpleNamespace(
        cache_key=lambda *args: args, cache_get=lambda key: cache.get(key),
        cache_set=lambda key, value, **_options: cache.__setitem__(key, value),
        throttle=Mock(), check_response=Mock())

    def build_url(route, _query=None, host=None, **_options):
        return (host or hosts[0]) + route

    scope = {
        "json": json, "gzip": gzip, "hashlib": hashlib, "requests": requests,
        "time": types.SimpleNamespace(sleep=lambda _delay: None),
        "SG": safeguard, "CFG": {"session_headers": {}}, "_pool": None,
        "session_loader": None, "HOST": hosts[0], "_API_HOSTS": hosts,
        "_api_host_pref": None, "_api_hosts_ordered": lambda: list(hosts),
        "sign": signer, "build_url": build_url, "http_request": http,
        "RiskControlError": RiskControlError, "AuthExpiredError": AuthExpiredError,
        "video_model_tracks": lambda model: model.get("video_list", []),
    }
    # Include small, literal policy constants only, not account/header/device defaults.
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if not isinstance(target, ast.Name) or not target.id.startswith("_HQ_"):
                continue
            if not any(word in target.id for word in ("TRIES", "RETR", "BUDGET", "LIMIT", "HOST", "ATTEMPT", "CODES")):
                continue
            try:
                value = ast.literal_eval(node.value)
            except (ValueError, TypeError):
                continue
            if isinstance(value, (bool, int, float, tuple, set)):
                scope[target.id] = value
    selected = set()

    def collect(name):
        if name in selected or name in scope or name not in definitions:
            return
        selected.add(name)
        for node in ast.walk(definitions[name]):
            if isinstance(node, ast.Name):
                collect(node.id)

    for name in ("get_video_tracks", "UpstreamResponseError", "_HQEmptyResponse"):
        collect(name)
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef))
             and node.name in selected]
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])),
                 str(source), "exec"), scope)
    return scope, signer

def use_real_host_order(scope):
    """Do not let a constant test host list hide mutable preferred-host races."""
    source=ROOT/'service/vendor/hongguo.py'
    tree=ast.parse(source.read_text(encoding='utf-8-sig'))
    method=next(node for node in tree.body if isinstance(node,ast.FunctionDef)
                and node.name=='_api_hosts_ordered')
    exec(compile(ast.Module(body=[method],type_ignores=[]),str(source),'exec'),scope)


class SourceContractTests(unittest.TestCase):
    def setUp(self):
        self.work = ROOT / "_work/playback-source-fix/tests"
        self.work.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(prefix="contract-", dir=self.work)
        self.data = Path(self.temporary.name)
        self.addCleanup(self.cleanup_owned_directory)
        self.sdk = types.SimpleNamespace(
            get_episodes=Mock(return_value=({"title": "本地合同 fixture", "series_id": SERIES},
                                           [{"index": EPISODE, "vid": VID, "duration": 44}])),
            get_video_tracks=Mock(return_value={VID: [playable_track()]}), http_request=Mock())
        self.provider = Provider(self.data, self.sdk)
        self.addCleanup(self.provider.close)
        self.downloaded = []

        def download(address, destination, cancelled):
            cancelled()
            self.downloaded.append(address)
            destination.write_bytes(b"complete-source-contract-fixture")
            return destination.stat().st_size

        self.provider.source_downloader.download = Mock(side_effect=download)

    def cleanup_owned_directory(self):
        if self.data.exists():
            self.assertFalse(self.data.is_symlink())
            self.assertEqual(self.data.resolve().parent, self.work.resolve())
            self.assertTrue(self.data.name.startswith("contract-"))
        self.temporary.cleanup()

    def use_real_sdk_control(self, http):
        scope, signer = offline_sdk(http)
        self.sdk.get_video_tracks = Mock(side_effect=lambda vids, **options:
                                        scope["get_video_tracks"](vids, **options))
        return scope, signer

    @staticmethod
    def response_with_track(codec="h264"):
        model = {"video_list": [playable_track(codec)]}
        entry = {"video_model": model}
        return OfflineResponse({"code": 0, "data": {"1004": {VID: entry},
                                  "video_model_data": {VID: entry}, VID: entry}})

    def test_empty_http200_has_a_source_wide_physical_model_budget_not_64_requests(self):
        physical = Mock(return_value=OfflineResponse())
        _scope, signer = self.use_real_sdk_control(physical)
        with self.assertRaises(ProviderError):
            self.provider.source(SERIES, EPISODE)
        self.assertGreater(physical.call_count, 0, "the real SDK HTTP seam was not exercised")
        self.assertEqual(signer.call_count, physical.call_count, "source calls must remain signed")
        self.assertLessEqual(physical.call_count, MAX_SOURCE_MODEL_HTTP,
                             "empty 200 must not scan eight hosts for each route and force round")
        self.assertFalse(self.downloaded)
        self.assertFalse(list(self.provider.source_dir.glob("*.mp4")))

    def test_failed_empty_model_is_not_negative_cached_and_a_later_valid_source_can_succeed(self):
        physical = Mock(return_value=OfflineResponse())
        self.use_real_sdk_control(physical)
        with self.assertRaises(ProviderError):
            self.provider.source(SERIES, EPISODE)
        physical.return_value = self.response_with_track()
        source = self.provider.source(SERIES, EPISODE)
        self.assertEqual(source.read_bytes(), b"complete-source-contract-fixture")
        self.assertEqual(len(self.downloaded), 1)

    def test_first_valid_signed_model_stops_before_refresh_or_website_and_cache_is_reused(self):
        physical = Mock(return_value=self.response_with_track())
        _scope, signer = self.use_real_sdk_control(physical)
        website = types.SimpleNamespace(playback_tracks=Mock(side_effect=AssertionError("unused website")))
        self.provider.web_search = website
        first = self.provider.source(SERIES, EPISODE, "1080p")
        self.provider.release_source(first)
        second = self.provider.source(SERIES, EPISODE, "1080p")
        self.provider.release_source(second)
        self.assertEqual(first, second)
        self.assertEqual(first.read_bytes(), b"complete-source-contract-fixture")
        self.assertEqual(physical.call_count, 1)
        self.assertEqual(signer.call_count, 1)
        self.assertEqual(self.sdk.get_video_tracks.call_count, 1)
        website.playback_tracks.assert_not_called()
        self.assertEqual(len(self.downloaded), 1)

    def test_primary_mobile_cause_is_not_replaced_by_secondary_website_400_or_403(self):
        for primary_code, status in (("UPSTREAM_TIMEOUT", 504), ("UPSTREAM_UNAVAILABLE", 502),
                                     ("MEDIA_SOURCE_EMPTY", 502)):
            for website_status in (400, 403):
                with self.subTest(primary=primary_code, website_status=website_status):
                    safe_message = "本地主源暂时失败: " + primary_code
                    self.sdk.get_video_tracks.side_effect = ProviderError(primary_code, safe_message, status)
                    client = Mock()
                    client.__enter__ = Mock(return_value=client)
                    client.__exit__ = Mock(return_value=False)
                    client.post.side_effect = [Mock(status_code=website_status, content=b"fixture-web-denial",
                        json=Mock(return_value={"error": "OFFLINE_PRIVATE_DIAGNOSTIC_MARKER"})) for _ in range(2)]
                    self.provider.web_search = OfficialWebSearch()
                    with patch("web_search.requests.Session", return_value=client), self.assertRaises(ProviderError) as caught:
                        self.provider.source(SERIES, EPISODE)
                    self.assertGreaterEqual(client.post.call_count, 1, "the website HTTP denial seam was not exercised")
                    self.assertLessEqual(client.post.call_count, 2)
                    self.assertEqual(caught.exception.code, primary_code)
                    self.assertEqual(caught.exception.status, status)
                    self.assertIn(primary_code, caught.exception.message)
                    self.assertNotIn("OFFLINE_PRIVATE_DIAGNOSTIC_MARKER", str(caught.exception))
                    self.assertFalse(self.downloaded)
                    self.assertFalse(list(self.provider.source_dir.glob("*.mp4")))

    def test_failed_mobile_cdn_cause_is_not_replaced_by_secondary_website_failure(self):
        self.provider.source_downloader.download.side_effect = requests.ConnectionError("controlled CDN failure")
        self.provider.web_search = types.SimpleNamespace(playback_tracks=Mock(side_effect=
            WebPlaybackError("WEB_PLAYBACK_UNAVAILABLE", "controlled secondary failure")))
        with self.assertRaises(ProviderError) as caught:
            self.provider.source(SERIES, EPISODE)
        self.assertEqual(caught.exception.code, "MEDIA_DOWNLOAD_FAILED")
        self.assertFalse(list(self.provider.source_dir.glob("*.mp4")))
        self.assertFalse(list(self.provider.source_dir.glob("*.partial")))

    def test_supported_hevc_source_keeps_its_same_episode_track_without_extra_model_negotiation(self):
        self.sdk.get_video_tracks.return_value = {VID: [playable_track("hevc")]}
        source = self.provider.source(SERIES, EPISODE, "1080p")
        self.assertEqual(source.read_bytes(), b"complete-source-contract-fixture")
        self.sdk.get_video_tracks.assert_called_once()
        self.sdk.http_request.assert_not_called()
        self.assertEqual(len(self.downloaded), 1)

    def test_cancellation_after_first_failed_download_stops_before_model_refresh_or_website(self):
        cancelled = [False]

        def fail_and_cancel(_address, destination, check):
            destination.write_bytes(b"partial-fixture")
            cancelled[0] = True
            check()

        self.provider.source_downloader.download.side_effect = fail_and_cancel
        website = types.SimpleNamespace(playback_tracks=Mock())
        self.provider.web_search = website
        with self.assertRaises(ProviderError) as caught:
            self.provider.source(SERIES, EPISODE, cancelled=lambda: cancelled[0])
        self.assertEqual(caught.exception.code, "MEDIA_CANCELLED")
        self.sdk.get_video_tracks.assert_called_once()
        website.playback_tracks.assert_not_called()
        self.assertFalse(list(self.provider.source_dir.glob("*.mp4")))
        self.assertFalse(list(self.provider.source_dir.glob("*.partial")))

    def test_website_account_or_device_switch_is_terminal_not_masked_by_prior_mobile_outage(self):
        for changed_key in ("uid", "device_id"):
            with self.subTest(changed_key=changed_key):
                current = [{"uid": "qa-account-a", "device_id": "qa-device-a"}]
                self.provider.account = types.SimpleNamespace(
                    load_session=lambda: dict(current[0]),
                    _session_identity=lambda context: (context.get("uid"), context.get("device_id")))
                self.sdk.get_video_tracks.side_effect = ProviderError("UPSTREAM_UNAVAILABLE", "controlled primary outage", 502)

                def returned(*_args, **_options):
                    current[0] = {**current[0], changed_key: "qa-context-b"}
                    return [playable_track()]

                self.provider.web_search = types.SimpleNamespace(playback_tracks=Mock(side_effect=returned))
                with self.assertRaises(ProviderError) as caught:
                    self.provider.source(SERIES, EPISODE)
                self.assertEqual(caught.exception.code, "ACCOUNT_CHANGED")
                self.assertFalse(self.downloaded)
                self.assertFalse(list(self.provider.source_dir.glob("*.mp4")))

    def test_terminal_mobile_failures_never_refresh_or_fall_back_to_website(self):
        cases = [(ProviderError("INPUT_INVALID", "controlled input failure", 400), "INPUT_INVALID"),
                 (ProviderError("MEDIA_CANCELLED", "controlled cancellation", 409), "MEDIA_CANCELLED"),
                 (AuthExpiredError("controlled login expiry"), "AUTH_EXPIRED"),
                 (RiskControlError("controlled challenge"), "UPSTREAM_RISK_CONTROL")]
        for failure, code in cases:
            with self.subTest(code=code):
                self.sdk.get_video_tracks.reset_mock()
                self.sdk.get_video_tracks.side_effect = failure
                website = types.SimpleNamespace(playback_tracks=Mock())
                self.provider.web_search = website
                with self.assertRaises(ProviderError) as caught:
                    self.provider.source(SERIES, EPISODE)
                self.assertEqual(caught.exception.code, code)
                self.sdk.get_video_tracks.assert_called_once()
                website.playback_tracks.assert_not_called()
                self.assertFalse(self.downloaded)


    def test_source_refresh_keeps_host_snapshot_when_catalog_changes_global_preference(self):
        physical=Mock();scope,signer=self.use_real_sdk_control(physical)
        use_real_host_order(scope)
        first,second=scope['_API_HOSTS'][:2]
        model_hosts=[]
        def response(_method,address,**_options):
            parsed=urlsplit(address);host=parsed.scheme+'://'+parsed.netloc
            if parsed.path=='/catalog-fixture':
                return OfflineResponse({'code':0,'data':{}}) if host==second else OfflineResponse()
            model_hosts.append(host)
            return self.response_with_track() if host==second else OfflineResponse()
        physical.side_effect=response
        self.sdk.playback_host_snapshot=Mock(side_effect=lambda:tuple(scope['_api_hosts_ordered']()))
        def tracks(vids,**options):
            try:return scope['get_video_tracks'](vids,**options)
            except scope['UpstreamResponseError']:
                if not options.get('force'):scope['api']('GET','/catalog-fixture')
                raise
        self.sdk.get_video_tracks.side_effect=tracks
        source=self.provider.source(SERIES,EPISODE)
        self.assertTrue(source.is_file())
        self.assertEqual(model_hosts,[first]*4+[second])
        self.assertLessEqual(len(model_hosts),MAX_SOURCE_MODEL_HTTP)
        self.sdk.playback_host_snapshot.assert_called_once()
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)

    def test_host_snapshot_capture_preserves_terminal_auth_risk_and_cancellation(self):
        website=types.SimpleNamespace(playback_tracks=Mock());self.provider.web_search=website
        for failure,expected in ((AuthExpiredError('controlled'),'AUTH_EXPIRED'),
                                 (RiskControlError('controlled'),'UPSTREAM_RISK_CONTROL')):
            with self.subTest(code=expected):
                self.sdk.get_video_tracks.reset_mock()
                self.sdk.playback_host_snapshot=Mock(side_effect=failure)
                with self.assertRaises(ProviderError) as caught:self.provider.source(SERIES,EPISODE)
                self.assertEqual(caught.exception.code,expected)
                self.sdk.get_video_tracks.assert_not_called();website.playback_tracks.assert_not_called()
        cancelled=[False]
        def snapshot():cancelled[0]=True;return ('only-model.example',)
        self.sdk.playback_host_snapshot=Mock(side_effect=snapshot)
        with self.assertRaises(ProviderError) as caught:
            self.provider.source(SERIES,EPISODE,cancelled=lambda:cancelled[0])
        self.assertEqual(caught.exception.code,'MEDIA_CANCELLED')
        self.sdk.get_video_tracks.assert_not_called();website.playback_tracks.assert_not_called()
        self.assertFalse(self.downloaded)

class SdkHostContractTests(unittest.TestCase):
    def setUp(self):
        self.physical = Mock(return_value=OfflineResponse())
        self.scope, self.signer = offline_sdk(self.physical)

    def test_default_nonplayback_api_still_tries_all_ordered_hosts(self):
        with self.assertRaises(self.scope["UpstreamResponseError"]):
            self.scope["api"]("GET", "/catalog/source-contract-default")
        self.assertEqual(self.physical.call_count, 8)
        self.assertEqual(self.signer.call_count, 8)
        self.assertEqual(len({urlsplit(call.args[1]).netloc for call in self.physical.call_args_list}), 8)

    def test_default_nonplayback_api_retains_transient_retry_and_unsigned_option(self):
        transient = RiskControlError("controlled transient response")
        transient.safe_response = {"code": 110001}
        self.physical.side_effect = [transient, OfflineResponse({"code": 0, "data": {}})]
        self.scope["api"]("GET", "/catalog/source-contract-default")
        self.assertEqual(self.physical.call_count, 2)
        self.assertEqual(self.signer.call_count, 2)
        self.physical.reset_mock()
        self.signer.reset_mock()
        self.physical.side_effect = None
        self.physical.return_value = OfflineResponse({"code": 0, "data": {}})
        self.scope["api"]("GET", "/catalog/source-contract-default", signed=False)
        self.physical.assert_called_once()
        self.signer.assert_not_called()

    def test_host_limit_and_offset_apply_to_the_request_without_changing_shared_hosts(self):
        for offset, expected_host in ((0, "model-0.example"), (1, "model-1.example"),
                                     (99, "model-0.example")):
            with self.subTest(offset=offset):
                self.physical.reset_mock()
                before = list(self.scope["_API_HOSTS"])
                with self.assertRaises(self.scope["UpstreamResponseError"]):
                    self.scope["api"]("GET", "/model/source-contract", max_retries=1,
                                       max_hosts=1, host_offset=offset)
                self.physical.assert_called_once()
                self.assertEqual(urlsplit(self.physical.call_args.args[1]).netloc, expected_host)
                self.assertEqual(self.scope["_API_HOSTS"], before)

    def test_invalid_host_budget_or_offset_stops_before_signing_and_transport(self):
        for options in ({"max_hosts": 0}, {"max_hosts": -1}, {"max_hosts": True},
                        {"max_hosts": 1.5}, {"host_offset": -1}, {"host_offset": True},
                        {"host_offset": 1.5}, {'host_snapshot':[]}, {'host_snapshot':True},
                        {'host_snapshot':'only-model.example'}, {'host_snapshot':['']}, {'host_snapshot':[1]}):
            with self.subTest(option_names=list(options)):
                with self.assertRaises(ValueError):
                    self.scope["api"]("GET", "/model/source-contract", **options)
        self.physical.assert_not_called()
        self.signer.assert_not_called()

    def test_four_contracts_remain_and_force_round_uses_only_the_next_host(self):
        for force in (False, True):
            with self.assertRaises(self.scope["UpstreamResponseError"]):
                self.scope["get_video_tracks"]([VID], force=force)
        self.assertEqual(self.physical.call_count, 8)
        self.assertEqual(self.signer.call_count, 8)
        paths = [urlsplit(call.args[1]).path for call in self.physical.call_args_list]
        expected = ["/novel/player/multi_video_model/player/v1",
                    "/reading/bookapi/video_tab/multi_video_model/v1/",
                    "/reading/bookapi/video_tab/video_model/v1/",
                    "/novel/player/multi_video_model/v1/"]
        self.assertEqual(paths, expected + expected)
        hosts = [urlsplit(call.args[1]).netloc for call in self.physical.call_args_list]
        self.assertEqual(hosts, ["model-0.example"] * 4 + ["model-1.example"] * 4)

    def test_single_host_force_refresh_safely_reuses_the_available_host(self):
        self.scope["_api_hosts_ordered"] = lambda: ["https://only-model.example"]
        with self.assertRaises(self.scope["UpstreamResponseError"]):
            self.scope["get_video_tracks"]([VID], force=True)
        self.assertEqual(self.physical.call_count, 4)
        self.assertEqual({urlsplit(call.args[1]).netloc for call in self.physical.call_args_list},
                         {"only-model.example"})

    def test_successful_initial_five_video_batch_needs_one_http_and_one_signature(self):
        vids = [str(int(VID) + index) for index in range(5)]
        entry = {"video_model": {"video_list": [playable_track()]}}
        self.physical.return_value = OfflineResponse({"code": 0, "data": {"1004": {vid: entry for vid in vids}}})
        models = self.scope["get_video_tracks"](vids)
        self.assertEqual(set(models), set(vids))
        self.physical.assert_called_once()
        self.signer.assert_called_once()
        self.assertEqual(self.physical.call_args.args[0], "POST")

    def test_authentication_and_risk_are_not_swallowed_by_any_of_the_four_contracts(self):
        for failing_contract in range(4):
            for failure_type in (AuthExpiredError, RiskControlError):
                with self.subTest(contract_index=failing_contract, failure_type=failure_type.__name__):
                    physical = Mock(side_effect=[OfflineResponse({"code": 0, "data": {}})
                        for _ in range(failing_contract)] + [failure_type("controlled terminal source response")])
                    scope, signer = offline_sdk(physical)
                    with self.assertRaises(failure_type):
                        scope["get_video_tracks"]([VID])
                    self.assertEqual(physical.call_count, failing_contract + 1)
                    self.assertEqual(signer.call_count, failing_contract + 1)


    def test_force_contracts_share_one_snapshot_despite_success_updating_global_preference(self):
        use_real_host_order(self.scope)
        second=self.scope['_API_HOSTS'][1]
        self.physical.return_value=OfflineResponse({'code':0,'data':{}})
        with self.assertRaises(self.scope['UpstreamResponseError']):
            self.scope['get_video_tracks']([VID],force=True)
        hosts=[call.args[1].rsplit('/novel/',1)[0] if '/novel/' in call.args[1]
               else call.args[1].rsplit('/reading/',1)[0] for call in self.physical.call_args_list]
        self.assertEqual(hosts,[second]*4)
        self.assertEqual(self.physical.call_count,4)
        self.assertEqual(self.signer.call_count,4)

    def test_caller_snapshot_is_copied_before_concurrent_list_mutation(self):
        use_real_host_order(self.scope)
        snapshot=self.scope['_API_HOSTS'][:2];second=snapshot[1]
        def changed(*_args,**_options):
            snapshot.reverse();return OfflineResponse({'code':0,'data':{}})
        self.physical.side_effect=changed
        with self.assertRaises(self.scope['UpstreamResponseError']):
            self.scope['get_video_tracks']([VID],force=True,host_snapshot=snapshot)
        hosts=[urlsplit(call.args[1]).scheme+'://'+urlsplit(call.args[1]).netloc
               for call in self.physical.call_args_list]
        self.assertEqual(hosts,[second]*4)
        self.assertEqual(self.physical.call_count,4)

if __name__ == "__main__":
    unittest.main()
