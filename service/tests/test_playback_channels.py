"""Official playback-channel failover, fresh model retrieval and cache isolation."""
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock
import requests

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'service'))
from provider import Provider,ProviderError
from web_search import WebPlaybackError
from vendor.safeguards import AuthExpiredError, RiskControlError

def track(url,definition='1080p',**backups):
    return {'video_meta':{'definition':definition,'codec_type':'h264'},
            'encrypt_info':{'encrypt':False},'main_url':url,**backups}

class PlaybackChannelTests(unittest.TestCase):
    def setUp(self):
        work=ROOT/'_work/playback-channel-tests';work.mkdir(parents=True,exist_ok=True)
        self.folder=tempfile.TemporaryDirectory(dir=work);self.addCleanup(self.folder.cleanup)
        self.root=Path(self.folder.name)
        self.old=track('https://cdn.example/expired.mp4')
        self.fresh=track('https://backup.example/fresh.mp4')
        self.sdk=types.SimpleNamespace(get_episodes=Mock(return_value=({'title':'测试剧集','series_id':'12345678'},
            [{'index':54,'vid':'23456789','duration':80}])),get_video_tracks=Mock(return_value={'23456789':[self.old]}),http_request=Mock())
        self.provider=Provider(self.root,self.sdk);self.addCleanup(self.provider.close)
        self.urls=[]
        def download(url,path,cancel):
            cancel();self.urls.append(url)
            if 'expired' in url:raise requests.HTTPError('Controlled CDN expired')
            path.write_bytes(b'complete-playback-fixture');return path.stat().st_size
        self.provider.source_downloader.download=Mock(side_effect=download)
    def test_expired_model_is_force_refreshed_once_after_all_of_its_urls_fail(self):
        self.sdk.get_video_tracks.side_effect=[{'23456789':[self.old]},{'23456789':[self.fresh]}]
        source=self.provider.source('12345678',54)
        self.assertEqual(source.read_bytes(),b'complete-playback-fixture')
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertEqual(self.sdk.get_video_tracks.call_args.kwargs,{'force':True})
        self.assertEqual(self.urls,['https://cdn.example/expired.mp4','https://backup.example/fresh.mp4'])

    def test_missing_same_episode_mobile_model_is_refreshed_without_website(self):
        self.sdk.get_video_tracks.side_effect=[{'34567890':[self.old]},{'23456789':[self.fresh]}]
        source=self.provider.source('12345678',54)
        self.assertEqual(source.read_bytes(),b'complete-playback-fixture')
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertEqual(self.sdk.get_video_tracks.call_args.kwargs,{'force':True})
        self.assertEqual(self.urls,['https://backup.example/fresh.mp4'])

    def test_empty_mobile_model_is_refreshed_before_website(self):
        self.sdk.get_video_tracks.side_effect=[{'23456789':[]},{'23456789':[self.fresh]}]
        website=types.SimpleNamespace(playback_tracks=Mock(return_value=[self.old]))
        self.provider.web_search=website
        self.assertTrue(self.provider.source('12345678',54).is_file())
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertEqual(self.sdk.get_video_tracks.call_args.kwargs,{'force':True})
        website.playback_tracks.assert_not_called()

    def test_temporary_mobile_timeout_is_refreshed_without_website(self):
        self.sdk.get_video_tracks.side_effect=[requests.Timeout('controlled timeout'),{'23456789':[self.fresh]}]
        self.assertTrue(self.provider.source('12345678',54).is_file())
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertEqual(self.sdk.get_video_tracks.call_args.kwargs,{'force':True})

    def test_temporary_mobile_outage_is_refreshed_before_website(self):
        self.sdk.get_video_tracks.side_effect=[RuntimeError('controlled outage'),{'23456789':[self.fresh]}]
        website=types.SimpleNamespace(playback_tracks=Mock(return_value=[self.old]))
        self.provider.web_search=website
        self.assertTrue(self.provider.source('12345678',54).is_file())
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertEqual(self.sdk.get_video_tracks.call_args.kwargs,{'force':True})
        website.playback_tracks.assert_not_called()
        self.assertEqual(self.urls,['https://backup.example/fresh.mp4'])

    def test_download_budget_keeps_room_for_a_refreshed_mobile_backup_without_website(self):
        stale=track('https://cdn.example/expired-main.mp4',
            backup_url_1='https://cdn.example/expired-first.mp4',
            backup_url='https://cdn.example/expired-second.mp4',
            backup_url_2='https://cdn.example/expired-third.mp4',
            backup_url_3='https://cdn.example/expired-fourth.mp4')
        refreshed=track('https://cdn.example/expired-refreshed-main.mp4',backup_url_1=self.fresh['main_url'])
        self.sdk.get_video_tracks.side_effect=[{'23456789':[stale,self.old]},{'23456789':[refreshed]}]
        self.assertTrue(self.provider.source('12345678',54).is_file())
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertIn(self.fresh['main_url'],self.urls)
        self.assertLessEqual(len(self.urls),6)

    def test_nonrecoverable_mobile_errors_stop_refresh_and_website(self):
        website=types.SimpleNamespace(playback_tracks=Mock(return_value=[self.fresh]))
        self.provider.web_search=website
        for code,status in (('AUTH_EXPIRED',401),('LOGIN_REQUIRED',401),('UPSTREAM_RISK_CONTROL',429),
                            ('MEDIA_ACCESS_RESTRICTED',403),('ACCOUNT_CHANGED',409),('MEDIA_CANCELLED',409),
                            ('SERVICE_STOPPING',503),('INPUT_INVALID',400)):
            with self.subTest(code=code):
                self.sdk.get_video_tracks.reset_mock()
                self.sdk.get_video_tracks.side_effect=ProviderError(code,'controlled terminal error',status)
                with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54)
                self.assertEqual(caught.exception.code,code)
                self.assertEqual(caught.exception.status,status)
                self.sdk.get_video_tracks.assert_called_once()
                website.playback_tracks.assert_not_called()
                self.assertFalse(list(self.provider.source_dir.glob('*.mp4')))

    def test_vendor_authentication_and_risk_errors_are_not_retried_as_outages(self):
        website=types.SimpleNamespace(playback_tracks=Mock(return_value=[self.fresh]))
        self.provider.web_search=website
        for failure,code,status in ((AuthExpiredError('controlled authentication expiry'),'AUTH_EXPIRED',401),
                                    (RiskControlError('controlled safety challenge'),'UPSTREAM_RISK_CONTROL',429)):
            with self.subTest(code=code):
                self.sdk.get_video_tracks.reset_mock()
                self.sdk.get_video_tracks.side_effect=failure
                with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54)
                self.assertEqual(caught.exception.code,code)
                self.assertEqual(caught.exception.status,status)
                self.sdk.get_video_tracks.assert_called_once()
                website.playback_tracks.assert_not_called()
                self.assertFalse(self.urls)

    def test_failed_model_refresh_preserves_the_last_safe_error_without_caching(self):
        final=ProviderError('UPSTREAM_UNAVAILABLE','controlled safe failure',502)
        self.sdk.get_video_tracks.side_effect=[requests.Timeout('controlled timeout'),final]
        with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54)
        self.assertIs(caught.exception,final)
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertFalse(list(self.provider.source_dir.glob('*.mp4')))
        self.assertFalse(list(self.provider.source_dir.glob('*.partial')))
        self.sdk.get_video_tracks.side_effect=None
        self.sdk.get_video_tracks.return_value={'23456789':[self.fresh]}
        self.assertTrue(self.provider.source('12345678',54).is_file())

    def test_failed_download_partial_is_removed_before_trying_a_new_address(self):
        self.sdk.get_video_tracks.side_effect=[{'23456789':[self.old]},{'23456789':[self.fresh]}]
        def download(url,path,cancel):
            cancel()
            self.assertFalse(path.exists())
            if url==self.old['main_url']:
                path.write_bytes(b'incomplete-source')
                raise requests.ConnectionError('controlled interrupted download')
            path.write_bytes(b'complete-playback-fixture')
            return path.stat().st_size
        self.provider.source_downloader.download.side_effect=download
        self.assertTrue(self.provider.source('12345678',54).is_file())
        self.assertFalse(list(self.provider.source_dir.glob('*.partial')))

    def test_authentication_failure_during_refresh_stops_before_website(self):
        self.sdk.get_video_tracks.side_effect=[{'23456789':[self.old]},AuthExpiredError('controlled authentication expiry')]
        website=types.SimpleNamespace(playback_tracks=Mock(return_value=[self.fresh]))
        self.provider.web_search=website
        with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54)
        self.assertEqual(caught.exception.code,'AUTH_EXPIRED')
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        website.playback_tracks.assert_not_called()
        self.assertFalse(list(self.provider.source_dir.glob('*.partial')))
    def test_second_official_backup_is_used_before_model_refresh(self):
        self.old['backup_url_2']='https://backup.example/second.mp4'
        source=self.provider.source('12345678',54)
        self.assertTrue(source.is_file())
        self.sdk.get_video_tracks.assert_called_once()
        self.assertEqual(self.urls,['https://cdn.example/expired.mp4','https://backup.example/second.mp4'])
    def test_same_episode_lower_quality_channel_can_rescue_dead_preferred_urls(self):
        self.sdk.get_video_tracks.return_value={'23456789':[self.old,track('https://backup.example/720.mp4','720p')]}
        source=self.provider.source('12345678',54,'1080p')
        self.assertTrue(source.is_file())
        self.assertIn('https://backup.example/720.mp4',self.urls)
        self.sdk.get_video_tracks.assert_called_once()
    def test_download_failure_does_not_cache_source_and_retries_are_bounded(self):
        self.sdk.get_video_tracks.return_value={'23456789':[self.old]}
        with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54)
        self.assertEqual(caught.exception.code,'MEDIA_DOWNLOAD_FAILED')
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertLessEqual(len(self.urls),6)
        self.assertFalse(list(self.provider.source_dir.glob('*.mp4')))
        self.sdk.get_video_tracks.return_value={'23456789':[self.fresh]}
        self.assertTrue(self.provider.source('12345678',54).is_file())
    def test_cancellation_stops_before_force_refresh_or_new_channel(self):
        stopped=[False]
        def download(url,path,cancel):stopped[0]=True;raise requests.HTTPError('Controlled failure')
        self.provider.source_downloader.download.side_effect=download
        with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54,cancelled=lambda:stopped[0])
        self.assertEqual(caught.exception.code,'MEDIA_CANCELLED')
        self.sdk.get_video_tracks.assert_called_once()
    def test_complete_source_cache_does_not_fetch_channels_again(self):
        self.sdk.get_video_tracks.return_value={'23456789':[self.fresh]}
        first=self.provider.source('12345678',54);self.provider.release_source(first)
        second=self.provider.source('12345678',54);self.provider.release_source(second)
        self.assertEqual(first,second)
        self.sdk.get_video_tracks.assert_called_once()

    def test_official_website_rescues_unavailable_mobile_model_for_the_same_episode(self):
        self.sdk.get_video_tracks.side_effect=RuntimeError('controlled unavailable mobile model')
        website=types.SimpleNamespace(playback_tracks=Mock(return_value=[self.fresh]))
        self.provider.web_search=website
        source=self.provider.source('12345678',54)
        self.assertTrue(source.is_file())
        self.assertEqual(self.sdk.get_video_tracks.call_count,2)
        self.assertEqual(self.sdk.get_video_tracks.call_args.kwargs,{'force':True})
        website.playback_tracks.assert_called_once()
        self.assertEqual(website.playback_tracks.call_args.args[:4],('23456789','12345678',54,'auto'))
        self.assertEqual(self.urls,['https://backup.example/fresh.mp4'])

    def test_website_gets_download_budget_after_mobile_channels_and_refresh_are_dead(self):
        self.sdk.get_video_tracks.return_value={'23456789':[track('https://cdn.example/expired-main.mp4',
            backup_url_1='https://cdn.example/expired-backup.mp4',backup_url='https://cdn.example/expired-more.mp4')]}
        self.provider.web_search=types.SimpleNamespace(playback_tracks=Mock(return_value=[self.fresh]))
        source=self.provider.source('12345678',54)
        self.assertTrue(source.is_file());self.assertLessEqual(len(self.urls),6)
        self.assertIn('https://backup.example/fresh.mp4',self.urls)
        self.provider.web_search.playback_tracks.assert_called_once()

    def test_website_permission_denial_is_not_cached_or_replaced_with_another_episode(self):
        self.sdk.get_video_tracks.side_effect=RuntimeError('controlled mobile outage')
        website=types.SimpleNamespace(playback_tracks=Mock(side_effect=WebPlaybackError('WEB_PLAYBACK_RESTRICTED','controlled restricted response')))
        self.provider.web_search=website
        with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54)
        self.assertEqual(caught.exception.code,'MEDIA_ACCESS_RESTRICTED')
        self.assertEqual(caught.exception.status,403)
        website.playback_tracks.assert_called_once()
        self.assertFalse(self.urls);self.assertFalse(list(self.provider.source_dir.glob('*.mp4')))

    def test_web_account_switch_discards_the_previous_accounts_playback_source(self):
        self.sdk.get_video_tracks.side_effect=RuntimeError('controlled mobile outage')
        current=[{'uid':'first','cookie':'synthetic-account-context'}]
        account=types.SimpleNamespace(load_session=lambda:dict(current[0]),_session_identity=lambda session:session.get('uid',''))
        self.provider.account=account
        def returned(*args,**options):current[0]={'uid':'second'};return[self.fresh]
        self.provider.web_search=types.SimpleNamespace(playback_tracks=Mock(side_effect=returned))
        with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54)
        self.assertEqual(caught.exception.code,'ACCOUNT_CHANGED')
        self.assertFalse(self.urls)

    def test_website_error_details_and_upstream_credentials_never_enter_the_ui(self):
        self.sdk.get_video_tracks.side_effect=RuntimeError('controlled mobile outage')
        self.provider.web_search=types.SimpleNamespace(playback_tracks=Mock(side_effect=WebPlaybackError('unexpected','synthetic-sensitive-value')))
        with self.assertRaises(ProviderError) as caught:self.provider.source('12345678',54)
        self.assertNotIn('synthetic-sensitive-value',str(caught.exception))
        self.assertEqual(caught.exception.code,'MEDIA_WEB_UNAVAILABLE')

if __name__=='__main__':unittest.main()
