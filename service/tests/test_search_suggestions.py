"""Provider and authenticated IPC routes for anonymous live search suggestions."""
import sys
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'service'))
from provider import Provider,ProviderError
from gateway import create_app
from search import SearchRows
from fastapi.testclient import TestClient

def item(index):
    return {'series_id':str(10000000+index),'title':'无敌财神'+str(index),'episode_cnt':77}

class SearchSuggestionsTests(unittest.TestCase):
    def setUp(self):
        work=ROOT/'_work/search-suggestions-tests';work.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=work);self.addCleanup(self.temp.cleanup)
        self.sdk=types.SimpleNamespace(suggestions=Mock(return_value=SearchRows([item(n) for n in range(8)])),search=Mock())
        self.web=types.SimpleNamespace(suggestions=Mock(return_value=[item(n) for n in range(8)]),search=Mock())
        self.provider=Provider(Path(self.temp.name),self.sdk,web_search=self.web);self.addCleanup(self.provider.close)

    def test_anonymous_official_web_suggestions_are_bounded_and_cached(self):
        for _ in range(2):
            result=self.provider.search_suggestions('无敌财神')
            self.assertEqual(len(result['items']),8);self.assertEqual(result['source'],'official-web')
        self.web.suggestions.assert_called_once_with('无敌财神',max_items=8)
        self.sdk.suggestions.assert_not_called()

    def test_web_failure_uses_mobile_drama_suggestions(self):
        self.web.suggestions.side_effect=RuntimeError('controlled unavailable')
        result=self.provider.search_suggestions('无敌财神')
        self.assertEqual(result['source'],'mobile');self.assertEqual(len(result['items']),8)
        self.sdk.suggestions.assert_called_once_with('无敌财神',max_items=8)

    def test_partial_suggestions_can_retry_without_cached_failure(self):
        self.web.suggestions.side_effect=RuntimeError('controlled unavailable')
        self.sdk.suggestions.side_effect=[SearchRows([item(0)],complete=False),SearchRows([item(0),item(1)])]
        self.assertIn('warning',self.provider.search_suggestions('无敌财神'))
        self.assertEqual(len(self.provider.search_suggestions('无敌财神')['items']),2)
        self.assertEqual(self.sdk.suggestions.call_count,2)

    def test_suggestion_route_remains_authenticated_and_passes_query(self):
        client=TestClient(create_app(self.provider,'a'*64))
        self.assertEqual(client.get('/catalog/search/suggestions?query=无敌财神').status_code,401)
        response=client.get('/catalog/search/suggestions?query=无敌财神',headers={'Authorization':'Bearer '+'a'*64})
        self.assertEqual(response.status_code,200);self.assertEqual(len(response.json()['items']),8)

    def test_invalid_query_does_not_contact_either_channel(self):
        with self.assertRaises(ProviderError):self.provider.search_suggestions('a\nb')
        self.web.suggestions.assert_not_called();self.sdk.suggestions.assert_not_called()

    def test_complete_mobile_search_failure_uses_official_web(self):
        self.sdk.search.side_effect=RuntimeError('controlled unavailable')
        self.web.search.return_value=[item(0),item(1)]
        result=self.provider.search('无敌财神')
        self.assertEqual(result['source'],'official-web');self.assertEqual(len(result['items']),2)

    def test_full_search_can_continue_beyond_40_results_without_duplicates(self):
        def page(query,*,offset=0,**_):
            rows=[item(n) for n in range(offset,min(offset+10,46))]
            return {'items':rows,'offset':offset+len(rows),'passback':'','search_id':'fixture-search',
                    'hasMore':offset+len(rows)<46,'complete':True}
        self.sdk.search_page=Mock(side_effect=page)
        rows=[];cursor=''
        while True:
            result=self.provider.search('无敌财神',cursor)
            rows.extend(result['items']);cursor=result['cursor']
            if not result['hasMore']:break
        self.assertEqual(len(rows),46);self.assertEqual(len({row['id'] for row in rows}),46)
        self.assertEqual(self.sdk.search_page.call_count,5)

    def test_pagination_cursor_cannot_be_reused_with_another_keyword(self):
        self.sdk.search_page=Mock(return_value={'items':[item(0)],'offset':1,'passback':'','search_id':'fixture','hasMore':True,'complete':True})
        first=self.provider.search('无敌财神')
        with self.assertRaises(ProviderError) as caught:self.provider.search('别的剧',first['cursor'])
        self.assertEqual(caught.exception.code,'CURSOR_EXPIRED')
        self.sdk.search_page.assert_called_once()

    def test_refresh_discards_successful_first_page_cache(self):
        self.sdk.search_page=Mock(return_value={'items':[item(0)],'offset':1,'passback':'','search_id':'','hasMore':False,'complete':True})
        self.provider.search('无敌财神');self.provider.search('无敌财神')
        self.assertEqual(self.sdk.search_page.call_count,1)
        self.provider.search('无敌财神',refresh=True)
        self.assertEqual(self.sdk.search_page.call_count,2)

if __name__=='__main__':unittest.main()
