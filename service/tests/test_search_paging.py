"""Exercise the actual SDK search pagination, with no signing or external requests."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
import warnings
from unittest.mock import Mock, patch

import requests

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'service'))


def cell(sid, title):
    return {'book_id': sid, 'video_detail': {'series_title': title, 'episode_cnt': 127}}


def page(rows, *, more=False, offset=0, passback=''):
    return {'code': 0, 'search_tabs': [{'tab_type': 29, 'data': rows, 'has_more': more,
            'next_offset': offset, 'passback': passback, 'search_id': 'synthetic-search'}]}


class SearchPagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        work = ROOT / '_work/search-paging-tests'
        work.mkdir(parents=True, exist_ok=True)
        config = work / 'content-config.json'
        config.write_text(json.dumps({'api_host': 'fixture.invalid', 'base_query': {},
                                      'session_headers': {}}), encoding='utf-8')
        spec = importlib.util.spec_from_file_location('vendor.search_paging_subject',
                ROOT / 'service/vendor/hongguo.py')
        cls.sdk = importlib.util.module_from_spec(spec)
        with patch.dict(os.environ, {'HONGGUO_CONTENT_CONFIG': str(config), 'REDIS_URL': ''}), warnings.catch_warnings():
            warnings.simplefilter('ignore', ResourceWarning)
            spec.loader.exec_module(cls.sdk)

    def setUp(self):
        self.api = Mock()
        self.cache_read = Mock(return_value=None)
        self.cache_write = Mock()
        for target in (patch.object(self.sdk, 'api', self.api),
                       patch.object(self.sdk.SG, 'cache_get', self.cache_read),
                       patch.object(self.sdk.SG, 'cache_set', self.cache_write)):
            target.start()
            self.addCleanup(target.stop)
        self.first = cell('7673742740500270105', '觉醒伪神：神明弃我我自为神')
        self.second = cell('7676383631534722073', '觉醒伪神：神明弃我我自为神2')

    def test_later_timeout_preserves_the_already_read_exact_match_and_can_retry(self):
        self.api.side_effect = [page([self.first], more=True, offset=1), requests.Timeout('synthetic failure')]
        partial = self.sdk.search('觉醒伪神', max_items=40)
        self.assertEqual([row['series_id'] for row in partial], [self.first['book_id']])
        self.assertFalse(partial.complete)
        self.cache_write.assert_not_called()
        self.api.reset_mock()
        self.api.side_effect = [page([self.first], more=True, offset=1), page([self.second])]
        complete = self.sdk.search('觉醒伪神', max_items=40)
        self.assertEqual(len(complete), 2)
        self.assertTrue(complete.complete)
        self.assertEqual(self.api.call_count, 2)
        self.cache_write.assert_called_once()

    def test_real_drama_tab_is_selected_instead_of_comprehensive_recommendations(self):
        title = '无敌财神！我觉醒了唯一隐藏职业'
        ids = ['7663491547907755033', '7672980478944611352', '7679746591594384409',
               '7687248701831515198', '7697459723225795646', '7703825719729589310']
        series = [cell(sid, title + (str(index) + '季' if index > 1 else '')) for index, sid in enumerate(ids, 1)]
        self.api.return_value = {'code': 0, 'selected_tab_idx': 1, 'search_tabs': [
            {'tab_type': 11, 'title': '综合', 'data': [series[0], cell('12345678', '无关推荐')], 'has_more': False},
            {'tab_type': 29, 'title': '剧集', 'data': series, 'has_more': False}]}
        result = self.sdk.search(title, max_items=40)
        self.assertEqual([row['series_id'] for row in result], ids)
        self.assertEqual(self.api.call_args.kwargs['extra_query']['tab_type'], '29')

    def test_series_page_exposes_only_parsed_hits_and_native_paging(self):
        self.api.return_value = page([self.first, self.second], more=True, offset=10, passback='next')
        result = self.sdk.search_page('觉醒伪神', offset=0)
        self.assertEqual(len(result['items']), 2)
        self.assertTrue(result['hasMore'])
        self.assertEqual(result['offset'], 10)
        self.assertEqual(result['passback'], 'next')
        self.assertTrue(result['complete'])

    def test_search_suggestions_read_only_one_episode_tab_page(self):
        self.api.return_value = page([self.first, self.second], more=True, offset=10)
        result = self.sdk.suggestions('觉醒伪神', max_items=1)
        self.assertEqual(len(result), 1)
        self.assertEqual(self.api.call_count, 1)
        self.assertEqual(self.api.call_args.kwargs['extra_query']['tab_type'], '29')

    def test_drama_tab_identity_wins_over_selected_index_and_response_order(self):
        self.api.return_value = {'selected_tab_idx': 0, 'search_tabs': [
            {'tab_type': 30, 'title': '视频', 'data': [cell('12345678', '其他内容')]},
            {'tab_type': '29', 'title': '剧集', 'data': [self.first], 'has_more': False},
            {'tab_type': 11, 'title': '综合', 'data': [self.second], 'has_more': False}]}
        result = self.sdk.search_page('觉醒伪神')
        self.assertEqual([row['series_id'] for row in result['items']], [self.first['book_id']])

    def test_absent_or_duplicate_drama_tab_does_not_silently_fall_back_to_recommendations(self):
        for tabs in ([{'tab_type': 11, 'data': [self.first]}],
                     [{'tab_type': 29, 'data': [self.first]}, {'tab_type': 29, 'data': [self.second]}]):
            self.api.return_value = {'search_tabs': tabs}
            with self.assertRaises(RuntimeError):
                self.sdk.search_page('觉醒伪神')

    def test_first_page_failure_still_reaches_the_provider_error_boundary(self):
        self.api.side_effect = requests.Timeout('synthetic failure')
        with self.assertRaises(requests.Timeout):
            self.sdk.search('觉醒伪神', max_items=40)
        self.cache_write.assert_not_called()

    def test_invalid_following_page_preserves_results_without_caching_success(self):
        for invalid in ({'code': 0}, {'search_tabs': 'invalid'}, {'search_tabs': ['invalid']},
                        {'search_tabs': [{'data': 'invalid'}]}):
            with self.subTest(shape=str(type(invalid.get('search_tabs')).__name__)):
                self.api.side_effect = [page([self.first], more=True, offset=1), invalid]
                result = self.sdk.search('觉醒伪神', max_items=40)
                self.assertEqual(len(result), 1)
                self.assertFalse(result.complete)
                self.cache_write.assert_not_called()

    def test_invalid_first_page_is_not_cached_as_an_empty_search(self):
        self.api.return_value = {'code': 0}
        with self.assertRaises(RuntimeError):
            self.sdk.search('觉醒伪神', max_items=40)
        self.cache_write.assert_not_called()

    def test_repeated_cursor_stops_after_the_repeat_and_retains_partial_rows(self):
        repeated = page([self.first], more=True, offset=0)
        repeated['search_tabs'][0]['search_id'] = ''
        self.api.return_value = repeated
        result = self.sdk.search('觉醒伪神', max_items=40)
        self.assertEqual(len(result), 1)
        self.assertEqual(self.api.call_count, 1)
        self.assertFalse(result.complete)
        self.cache_write.assert_not_called()

    def test_same_offset_can_continue_when_the_server_passback_advances(self):
        self.api.side_effect = [page([self.first], more=True, offset=0, passback='page-two'),
                                page([self.second])]
        result = self.sdk.search('觉醒伪神', max_items=40)
        self.assertEqual(len(result), 2)
        self.assertTrue(result.complete)
        self.assertEqual(self.api.call_args_list[1].kwargs['extra_query']['passback'], 'page-two')

    def test_empty_terminal_search_remains_a_valid_cacheable_result(self):
        self.api.return_value = {'search_tabs': []}
        result = self.sdk.search('没有匹配的作品', max_items=40)
        self.assertEqual(result, [])
        self.assertTrue(result.complete)
        self.cache_write.assert_called_once()

    def test_requested_limit_is_complete_even_if_the_server_has_further_pages(self):
        self.api.return_value = page([self.first, self.second], more=True, offset=2)
        result = self.sdk.search('觉醒伪神', max_items=1)
        self.assertEqual(len(result), 1)
        self.assertTrue(result.complete)
        self.assertEqual(self.api.call_count, 1)
        self.cache_write.assert_called_once()

    def test_empty_continuing_page_is_partial_and_cannot_poison_the_cache(self):
        self.api.side_effect = [page([self.first], more=True, offset=1), page([], more=True, offset=2)]
        result = self.sdk.search('觉醒伪神', max_items=40)
        self.assertEqual(len(result), 1)
        self.assertFalse(result.complete)
        self.cache_write.assert_not_called()

    def test_malformed_cells_do_not_discard_valid_neighbors_or_cache_an_incomplete_page(self):
        self.api.return_value = page([self.first, {'book_id': '12345678', 'video_detail': 'invalid'},
                                      'invalid-cell', self.second])
        result = self.sdk.search('觉醒伪神', max_items=40)
        self.assertEqual([row['series_id'] for row in result], [self.first['book_id'], self.second['book_id']])
        self.assertFalse(result.complete)
        self.cache_write.assert_not_called()

    def test_page_bound_keeps_collected_rows_but_does_not_cache_them_as_complete(self):
        self.api.side_effect = [page([cell(str(12345678 + number), f'作品{number}')],
                                more=True, offset=number + 1) for number in range(12)]
        result = self.sdk.search('作品', max_items=40)
        self.assertEqual(len(result), 12)
        self.assertEqual(self.api.call_count, 12)
        self.assertFalse(result.complete)
        self.cache_write.assert_not_called()

    def test_cached_complete_rows_keep_the_list_contract_and_skip_upstream_reads(self):
        self.cache_read.return_value = [{'series_id': self.first['book_id'], 'title': '缓存作品'}]
        result = self.sdk.search('缓存作品', max_items=40)
        self.assertEqual(len(result), 1)
        self.assertTrue(result.complete)
        self.api.assert_not_called()


if __name__ == '__main__':
    unittest.main()
