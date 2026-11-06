"""Category contracts only; no account or playback-progress operations."""
import ast
from pathlib import Path
import re
import sys
import types
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from gateway import create_app
from provider import Provider, ProviderError


class CategoryTests(unittest.TestCase):
    def setUp(self):
        self.work = Path(__file__).resolve().parent / '.work' / 'categories' / self._testMethodName
        self.work.mkdir(parents=True, exist_ok=True)
        self.sdk = types.SimpleNamespace(filters=Mock(return_value=[
            {'type': 'category_dim_theme', 'items': [{'id': 'cate_5000', 'name': '爱情'}, {'id': 'cate_5021', 'name': '年代'}]},
            {'type': 'category_dim_role', 'items': [{'id': 'cate_5221', 'name': '女强'}]},
            {'type': 'category_dim_epoch', 'items': [{'id': 'cate_5338', 'name': '现代'}]},
        ]), browse_page=Mock(return_value={'items': [{'series_id': '12345678', 'title': '分类测试', 'category': ['爱情', '女强', '现代']}],
                                         'offset': 18, 'shown': ['12345678'], 'hasMore': True}))
        self.provider = Provider(self.work, self.sdk, types.SimpleNamespace())
        self.addCleanup(self.provider.close)

    def test_filters_keep_live_dimensions_and_ids(self):
        filters = self.provider.filters('short_play')['filters']
        self.assertEqual([group['name'] for group in filters['groups']], ['题材', '设定', '背景'])
        self.assertEqual(filters['themeOptions'], [{'id': 'cate_5000', 'name': '爱情'}, {'id': 'cate_5021', 'name': '年代'}])
        self.assertNotIn('cate_79', str(filters))

    def test_combined_filters_reach_real_leaf_without_name_mapping(self):
        result = self.provider.browse('short_play', 'hot_score', 'cate_5000', 'cate_5221', 'cate_5338')
        self.sdk.browse_page.assert_called_once_with('short_play', sort='hot_score', theme='cate_5000', setting='cate_5221', background='cate_5338', offset=0, shown=[])
        self.assertEqual(result['items'][0]['tags'], ['爱情', '女强', '现代'])
        self.assertTrue(result['hasMore'])

    def test_load_more_uses_same_filters_offset_and_exclusions(self):
        first = self.provider.browse(theme='cate_5000')
        self.provider.browse(theme='cate_5000', cursor=first['cursor'])
        self.assertEqual(self.sdk.browse_page.call_args.kwargs['offset'], 18)
        self.assertEqual(self.sdk.browse_page.call_args.kwargs['shown'], ['12345678'])
        self.assertEqual(self.sdk.browse_page.call_args.kwargs['theme'], 'cate_5000')
        self.provider.browse(theme='cate_5021')
        self.assertEqual(self.sdk.browse_page.call_args.kwargs['offset'], 0)
        self.assertEqual(self.sdk.browse_page.call_args.kwargs['shown'], [])

    def test_cursor_cannot_be_reused_for_another_category(self):
        first = self.provider.browse(theme='cate_5000')
        with self.assertRaises(ProviderError) as error:
            self.provider.browse(theme='cate_5021', cursor=first['cursor'])
        self.assertEqual(error.exception.code, 'CURSOR_EXPIRED')
        self.assertEqual(self.sdk.browse_page.call_count, 1)

    def test_unknown_or_old_dimension_id_never_fetches_a_fake_catalog(self):
        with self.assertRaises(ProviderError):
            self.provider.browse(theme='cate_79')
        self.sdk.browse_page.assert_not_called()

    def test_gateway_exposes_filters_and_keeps_query_dimensions(self):
        client = TestClient(create_app(self.provider, 'a' * 64))
        headers = {'Authorization': 'Bearer ' + 'a' * 64}
        self.assertEqual(client.get('/catalog/filters?genre=short_play', headers=headers).status_code, 200)
        response = client.get('/catalog/browse?genre=short_play&theme=cate_5021&setting=cate_5221&background=cate_5338', headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.sdk.browse_page.call_args.kwargs['theme'], 'cate_5021')


class CategoryLeafTests(unittest.TestCase):
    def test_real_leaf_posts_live_ids_and_vendor_pagination(self):
        source = Path(__file__).resolve().parents[1] / 'vendor' / 'hongguo.py'
        parsed = ast.parse(source.read_text(encoding='utf-8'))
        leaf = next(node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == 'browse_page')
        api = Mock(return_value={'data': {'has_more': True, 'video_data': [
            {'series_id': '12345678', 'title': '测试', 'category_schema': '[{"name": "年代"}, {"name":"现代"}]'}]}})
        namespace = {'GENRES': {'short_play': ('default', 'short_play')}, 'FILTER_CATE': {},
                     '_ids': lambda value, mapping: [value] if value else [], 'SIGN_LIST': True, 'api': api, 're': re}
        exec(compile(ast.Module(body=[leaf], type_ignores=[]), str(source), 'exec'), namespace)
        result = namespace['browse_page'](theme='cate_5021', background='cate_5338', offset=18, shown=['23456789'])
        body = api.call_args.kwargs['body']
        self.assertEqual(body['select_items']['category_dim_theme'], ['cate_5021'])
        self.assertEqual(body['select_items']['category_dim_epoch'], ['cate_5338'])
        self.assertEqual((body['offset'], body['filter_ids']), (18, '23456789'))
        self.assertTrue(api.call_args.kwargs['signed'])
        self.assertEqual(result['items'][0]['category'], ['年代', '现代'])
        self.assertEqual(result['offset'], 19)


if __name__ == '__main__':
    unittest.main()
