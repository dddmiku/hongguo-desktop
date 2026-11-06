"""Regression tests use synthetic identifiers; never call the cloud."""
import time
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from progress_contract import build_progress_item, epoch_seconds, mobile_position_seconds, seconds_to_ms


class ProgressContractTests(unittest.TestCase):
    def item(self, timestamp=None, position=27.25, episode=20):
        return build_progress_item({"id": "12345678", "title": "测试剧"}, episode, "23456789", position, 120.5,
                                   timestamp if timestamp is not None else time.time(), 99)

    def test_desktop_epoch_seconds_are_sent_as_mobile_milliseconds(self):
        now = int(time.time())
        self.assertEqual(self.item(now)["read_timestamp_ms"], now * 1000)
        self.assertEqual(self.item(now * 1000)["read_timestamp_ms"], now * 1000)

    def test_seconds_position_and_duration_have_mobile_units(self):
        item = self.item()
        self.assertEqual(item["current_play_position"], 27250)
        self.assertEqual(item["player_accumulate_total_time"], 27250)
        self.assertEqual(item["duration"], 120500)
        self.assertNotIn("last_play_duration", item)

    def test_episode_and_selected_vid_remain_one_based(self):
        item = self.item(episode=20)
        self.assertEqual(item["vid_index"], 20)
        self.assertEqual(item["chapter_index"], 20)
        self.assertEqual(item["vid"], 23456789)
        self.assertEqual(item["episode_cnt"], 99)
        self.assertFalse(item["is_delete"])
        self.assertFalse(item["use_soft_delete"])

    def test_mobile_readbacks_are_normalized_without_truncating_seconds(self):
        self.assertEqual(mobile_position_seconds(31171), 31.171)
        self.assertEqual(epoch_seconds(1792159481691), 1792159481.691)

    def test_invalid_or_future_times_never_produce_a_payload(self):
        for value in (float("nan"), -1, True, 100000):
            with self.assertRaises(ValueError): seconds_to_ms(value)
        with self.assertRaises(ValueError): self.item(time.time() + 120)
        with self.assertRaises(ValueError): self.item(episode=0)


if __name__ == "__main__":
    unittest.main()
