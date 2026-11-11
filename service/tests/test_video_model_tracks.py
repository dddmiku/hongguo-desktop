"""Normalize actual SDK models before the downloader selects a backup."""
import ast
import base64
from pathlib import Path
import unittest


class VideoModelTracksTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / 'vendor/hongguo.py'
        parsed = ast.parse(source.read_text(encoding='utf-8'))
        function = next(node for node in parsed.body
                        if isinstance(node, ast.FunctionDef) and node.name == 'video_model_tracks')
        namespace = {}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), 'exec'), namespace)
        self.normalize = namespace['video_model_tracks']

    def test_encoded_second_and_third_backups_become_downloadable_urls(self):
        backups = {key: base64.b64encode(f'https://cdn.example/{key}.mp4'.encode()).decode()
                   for key in ('backup_url_2', 'backup_url_3')}
        result = self.normalize({'video_list': {'video_1': {
            'main_url': 'https://cdn.example/main.mp4', **backups,
            'codec_type': 'h264', 'definition': '720p', 'encrypt': False}}})
        for key in backups:
            self.assertEqual(result[0][key], f'https://cdn.example/{key}.mp4')
        self.assertEqual(result[0]['video_meta']['codec_type'], 'h264')

    def test_all_backups_receive_the_same_validation_as_the_main_url(self):
        for key in ('backup_url_2', 'backup_url_3'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.normalize({'video_list': [{'main_url': 'https://cdn.example/main.mp4',
                                                key: base64.b64encode(b'file:///invalid.mp4').decode()}]})

    def test_missing_extra_backups_preserve_older_models(self):
        result = self.normalize({'video_list': [{'main_url': 'https://cdn.example/main.mp4',
                                                'video_meta': {'codec_type': 'hevc'}}]})
        self.assertEqual(result[0]['main_url'], 'https://cdn.example/main.mp4')
        self.assertNotIn('backup_url_2', result[0])


if __name__ == '__main__':
    unittest.main()
