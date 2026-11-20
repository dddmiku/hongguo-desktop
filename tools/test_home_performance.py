"""Regression checks for independent benchmark profiles and bounded startup reads."""
from pathlib import Path
import threading
import tempfile
import unittest
from unittest.mock import Mock

from tools.home_performance import create_run_profile, read_ready


class HomePerformanceTests(unittest.TestCase):
    def test_each_run_gets_a_fresh_profile_path_for_an_isolated_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            first = create_run_profile(root, 1)
            second = create_run_profile(root, 2)
            self.assertNotEqual(first, second)
            self.assertEqual(first.parent, second.parent)
            self.assertTrue(first.is_dir() and second.is_dir())

    def test_startup_read_is_bounded_and_kills_a_nonready_process(self):
        process = Mock()
        blocked = threading.Event()
        process.stdout.readline.side_effect = lambda: (blocked.wait(), b"")[1]
        process.kill.return_value = None
        process.wait.return_value = 0
        kill_tree = Mock()
        with self.assertRaisesRegex(TimeoutError, "startup timeout"):
            read_ready(process, timeout=0.02, on_timeout=kill_tree)
        kill_tree.assert_called_once_with()
        process.kill.assert_not_called()
        process.wait.assert_called_once_with(timeout=10)

    def test_startup_read_parses_the_readiness_record(self):
        process = Mock()
        process.stdout.readline.return_value = b'{"port":43210}\n'
        self.assertEqual(read_ready(process, timeout=1), {"port": 43210})
        process.kill.assert_not_called()


if __name__ == "__main__":
    unittest.main()
