import sys
from pathlib import Path
import unittest
from unittest.mock import Mock
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from web_search import OfficialWebSearch,WebSearchError,WebPlaybackError

class WebSearchTests(unittest.TestCase):
    def test_anonymous_suggestions_keep_only_real_series_and_deduplicate(self):
        real={'video_data':{'series_id':'7663491547907755033','series_title':'无敌财神','episode_cnt':77}}
        response={'suggestionList':[real,{'name':'无敌财神第七季','video_data':None},real,{'video_data':{'series_id':'missing','series_title':'无效'}}]}
        transport=Mock(return_value=response)
        rows=OfficialWebSearch(transport).suggestions('无敌财神')
        self.assertEqual([(row['series_id'],row['episode_cnt']) for row in rows],[('7663491547907755033',77)])
        transport.assert_called_once_with('/api/search/suggestion',{'aid':'8662','query':'无敌财神'})

    def test_result_supports_real_nested_video_data_without_other_fields(self):
        transport=Mock(return_value={'searchList':[{'video_data':[{'series_id':'7663491547907755033','series_title':'无敌财神','episode_cnt':77}]}]})
        self.assertEqual(OfficialWebSearch(transport).search('无敌财神')[0]['title'],'无敌财神')

    def test_malformed_upstream_cannot_be_a_successful_empty_result(self):
        for value in ({'code':400},{'suggestionList':None},[]):
            with self.subTest(value=value),self.assertRaises(WebSearchError):OfficialWebSearch(lambda *args:value).suggestions('无敌财神')

    def test_invalid_query_never_reaches_transport(self):
        transport=Mock()
        with self.assertRaises(ValueError):OfficialWebSearch(transport).suggestions('a\nb')
        transport.assert_not_called()

    def client(self,responses):
        client=Mock();client.__enter__=Mock(return_value=client);client.__exit__=Mock(return_value=False)
        client.post.side_effect=[Mock(status_code=status,content=b'bounded',json=Mock(return_value=value)) for status,value in responses]
        return client

    def test_official_playback_uses_only_current_episode_and_clear_allowed_vod(self):
        client=self.client([(200,{'base_resp':{'StatusCode':0},'legacy_play_info':{'main_url':'https://v3-hgweb.qznovelvod.com/fixture.mp4','width':'640','height':'360'}}),(200,{'main_url':'https://v3-hgweb.qznovelvod.com/fixture.mp4'})])
        with patch('web_search.requests.Session',return_value=client):
            tracks=OfficialWebSearch().playback_tracks('11111111','22222222',54,'720p')
        self.assertEqual(tracks[0]['_official_channel'],'website');self.assertFalse(tracks[0]['encrypt_info']['encrypt'])
        self.assertEqual(client.post.call_args_list[0].kwargs['json'],{'item_id':'11111111','series_id':'22222222','definition':'720p'})
        self.assertEqual(len(tracks),1);self.assertEqual(tracks[0]['video_meta']['definition'],'360p')

    def test_denied_episode_cannot_fall_back_to_some_other_preview(self):
        client=self.client([(403,{'error':'protected_playback_unavailable'}),(403,{'error':'protected_playback_unavailable'})])
        with patch('web_search.requests.Session',return_value=client),self.assertRaises(WebPlaybackError) as caught:
            OfficialWebSearch().playback_tracks('11111111','22222222',54,'720p')
        self.assertEqual(caught.exception.code,'WEB_PLAYBACK_RESTRICTED')
        self.assertTrue(all(call.kwargs['json']['item_id']=='11111111' for call in client.post.call_args_list))

    def test_untrusted_media_address_is_never_used(self):
        client=self.client([(200,{'main_url':'https://untrusted.example/fixture.mp4'}),(200,{'main_url':'http://127.0.0.1/private.mp4'})])
        with patch('web_search.requests.Session',return_value=client),self.assertRaises(WebPlaybackError):
            OfficialWebSearch().playback_tracks('11111111','22222222',1,'720p')

if __name__=='__main__':unittest.main()
