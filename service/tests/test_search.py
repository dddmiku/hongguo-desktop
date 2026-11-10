"""Search regressions: full titles retain sequels with one bounded fallback."""
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from provider import Provider, ProviderError
from search import SearchRows, fallback_query, title_key


BASE = '觉醒伪神'
TITLE = BASE + '：神明弃我我自为神'
CURRENT = '7673742740500270105'
SEQUELS = [
    ('7676383631534722073', 2, 139), ('7677963872489196569', 3, 120),
    ('7683036877804293144', 4, 152), ('7685717973641727038', 5, 192),
    ('7690409104472296510', 6, 192), ('7697852455970671678', 7, 193),
    ('7704219652255140889', 8, 213),
]


def series(sid, title, count=1):
    return {'series_id': sid, 'title': title, 'episode_cnt': count}


def family():
    first = series(CURRENT, TITLE, 127)
    sequels = [series(sid, TITLE + str(index), count) for sid, index, count in SEQUELS]
    return [first, sequels[-1], *sequels[:-1]]


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(__file__).resolve().parent / '.work' / self._testMethodName
        self.work.mkdir(parents=True, exist_ok=True)
        self.sdk = types.SimpleNamespace(search=Mock())
        self.provider = Provider(self.work, self.sdk)
        self.addCleanup(self.provider.close)

    def fixture(self, exact_query=TITLE):
        first = family()[0]
        unrelated = [series(str(12340000 + index), '其他作品' + str(index)) for index in range(39)]
        self.sdk.search.side_effect = lambda query, **_: [first, *unrelated] if query == exact_query else family()

    def test_full_title_with_existing_exact_hit_still_adds_all_seasons(self):
        self.fixture()
        items = self.provider.search(TITLE)['items']
        self.assertEqual([item['id'] for item in items[:8]], [CURRENT, *[row[0] for row in SEQUELS]])
        self.assertEqual(len(items), 40)
        self.assertEqual([call.args[0] for call in self.sdk.search.call_args_list], [TITLE, BASE])

    def test_full_and_half_width_punctuation_and_poster_comma_find_same_family(self):
        query = '觉醒伪神:神明弃我,我自为神'
        self.fixture(query)
        items = self.provider.search(query)['items']
        self.assertEqual([item['id'] for item in items[:8]], [CURRENT, *[row[0] for row in SEQUELS]])
        self.assertEqual(title_key(query), title_key(TITLE))
        self.assertEqual(self.sdk.search.call_args_list[0].args, (query,))

    def test_punctuation_omitted_in_query_can_use_the_exact_hit_main_title(self):
        query = '觉醒伪神神明弃我我自为神'
        self.fixture(query)
        self.assertEqual(len([row for row in self.provider.search(query)['items'] if BASE in row['title']]), 8)
        self.assertEqual([call.args[0] for call in self.sdk.search.call_args_list], [query, BASE])

    def test_explicit_season_is_first_then_other_seasons_are_ordered(self):
        query = TITLE + '第八季'
        eighth = family()[1]
        self.sdk.search.side_effect = lambda term, **_: [eighth] if term == query else family()
        items = self.provider.search(query)['items']
        self.assertEqual([row['id'] for row in items], [SEQUELS[-1][0], CURRENT, *[row[0] for row in SEQUELS[:-1]]])
        self.assertEqual([call.args[0] for call in self.sdk.search.call_args_list], [query, BASE])

    def test_abbreviated_explicit_season_can_discover_the_full_title_family(self):
        query = BASE + '第二季'
        self.sdk.search.side_effect = lambda term, **_: [family()[2]] if term == query else family()
        items = self.provider.search(query)['items']
        self.assertEqual(items[0]['id'], SEQUELS[0][0])
        self.assertEqual(len(items), 8)

    def test_short_title_uses_one_query_and_orders_existing_seasons(self):
        self.sdk.search.return_value = family()
        self.assertEqual([row['id'] for row in self.provider.search(BASE)['items']],
                         [CURRENT, *[row[0] for row in SEQUELS]])
        self.sdk.search.assert_called_once_with(BASE, max_items=40)

    def test_related_fallback_does_not_add_other_subtitles_or_fuzzy_recommendations(self):
        other = [series('99999998', BASE + '：别的故事2'), series('99999999', '神明弃我2')]
        self.sdk.search.side_effect = lambda term, **_: [family()[0]] if term == TITLE else [*family(), *other]
        items = self.provider.search(TITLE)['items']
        self.assertEqual(len(items), 8)
        self.assertFalse({'99999998', '99999999'} & {row['id'] for row in items})

    def test_deduplication_uses_id_preserves_exact_data_and_distinct_equal_titles(self):
        first = family()[0]
        self.sdk.search.side_effect = lambda term, **_: [first] if term == TITLE else [
            {**first, 'episode_cnt': 999}, series('99999999', TITLE), *family()[1:]]
        items = self.provider.search(TITLE)['items']
        self.assertEqual(len(items), 9)
        self.assertEqual(items[0]['totalEpisodes'], 127)
        self.assertEqual(len({row['id'] for row in items}), len(items))

    def test_exact_title_is_promoted_ahead_of_upstream_fuzzy_hits(self):
        self.sdk.search.return_value = [series('99999999', '无关标题'), series('99999998', '春风')]
        self.assertEqual(self.provider.search('春风')['items'][0]['title'], '春风')
        self.sdk.search.assert_called_once_with('春风', max_items=40)

    def test_unrelated_keyword_results_keep_upstream_order_and_make_no_extra_query(self):
        rows = [series('99999999', '甲'), series('99999998', '乙'), series('99999997', '丙')]
        self.sdk.search.return_value = rows
        self.assertEqual([row['title'] for row in self.provider.search('关键词')['items']], ['甲', '乙', '丙'])
        self.sdk.search.assert_called_once()

    def test_cached_exact_and_base_queries_are_reused_across_searches(self):
        self.fixture()
        self.provider.search(TITLE)
        self.provider.search(TITLE)
        self.provider.search(BASE)
        self.assertEqual(self.sdk.search.call_count, 2)

    def test_optional_fallback_error_keeps_exact_hits_and_can_retry(self):
        attempts = [0]
        def fetch(term, **_):
            if term == TITLE:
                return [family()[0]]
            attempts[0] += 1
            if attempts[0] == 1:
                raise RuntimeError('fixed upstream failure')
            return family()
        self.sdk.search.side_effect = fetch
        first = self.provider.search(TITLE)
        self.assertEqual([row['id'] for row in first['items']], [CURRENT])
        self.assertIn('warning', first)
        second = self.provider.search(TITLE)
        self.assertEqual(len(second['items']), 8)
        self.assertNotIn('warning', second)
        self.assertEqual(self.sdk.search.call_count, 3)

    def test_primary_failure_for_short_keyword_has_no_unrelated_fallback(self):
        self.sdk.search.side_effect = RuntimeError('fixed upstream failure')
        with self.assertRaises(ProviderError):
            self.provider.search(BASE)
        self.sdk.search.assert_called_once()

    def test_failed_full_title_can_use_main_title_and_retry_original_next_time(self):
        attempts = [0]
        def fetch(term, **_):
            if term == TITLE:
                attempts[0] += 1
                if attempts[0] == 1:
                    raise RuntimeError('fixed full-title failure')
            return family()
        self.sdk.search.side_effect = fetch
        first = self.provider.search(TITLE)
        self.assertEqual(len(first['items']), 8)
        self.assertIn('warning', first)
        second = self.provider.search(TITLE)
        self.assertEqual(len(second['items']), 8)
        self.assertNotIn('warning', second)
        self.assertEqual(self.sdk.search.call_count, 3)

    def test_failed_primary_does_not_show_unrelated_main_title_hits_as_success(self):
        self.sdk.search.side_effect = lambda term, **_: (_ for _ in ()).throw(RuntimeError('fixed failure')) if term == TITLE else [series('99999999', '无关作品')]
        with self.assertRaises(ProviderError):
            self.provider.search(TITLE)
        self.assertEqual(self.sdk.search.call_count, 2)

    def test_failed_primary_and_fallback_preserve_original_timeout(self):
        import requests
        self.sdk.search.side_effect = [requests.Timeout('controlled timeout'), RuntimeError('fixed fallback failure')]
        with self.assertRaises(ProviderError) as caught:
            self.provider.search(TITLE)
        self.assertEqual(caught.exception.code, 'UPSTREAM_TIMEOUT')

    def test_incomplete_pages_keep_results_with_warning_and_are_not_cached(self):
        self.sdk.search.side_effect = [SearchRows(family()[:1], complete=False), family()]
        first = self.provider.search(BASE)
        self.assertEqual([row['id'] for row in first['items']], [CURRENT])
        self.assertIn('warning', first)
        second = self.provider.search(BASE)
        self.assertEqual(len(second['items']), 8)
        self.assertNotIn('warning', second)
        self.assertEqual(self.sdk.search.call_count, 2)

    def test_no_fallback_for_one_character_main_title_or_special_editions(self):
        for title in ('神：另一个标题', TITLE + '番外第二季', TITLE + '新版'):
            with self.subTest(title=title):
                self.assertEqual(fallback_query(title), '')


if __name__ == '__main__':
    unittest.main()
