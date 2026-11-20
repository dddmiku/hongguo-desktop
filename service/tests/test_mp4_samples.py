"""Reject malformed MP4 chunk maps before expanding stsc runs."""
import struct
import unittest
from unittest.mock import patch

from service.vendor import mp4_samples


def box(kind, payload):
    return struct.pack(">I4s", len(payload) + 8, kind) + payload


def fullbox(kind, payload):
    return box(kind, b"\0\0\0\0" + payload)


def fixture(stsc_rows, chunk_count=2):
    hdlr = fullbox(b"hdlr", b"\0\0\0\0vide")
    stsz = fullbox(b"stsz", struct.pack(">II", 5, 2))
    stco = fullbox(b"stco", struct.pack(">I", chunk_count) + b"".join(
        struct.pack(">I", 100 + 20 * index) for index in range(chunk_count)))
    stsc = fullbox(b"stsc", struct.pack(">I", len(stsc_rows)) + b"".join(
        struct.pack(">III", *row) for row in stsc_rows))
    stbl = box(b"stbl", stsz + stco + stsc)
    minf = box(b"minf", stbl)
    mdia = box(b"mdia", hdlr + minf)
    return box(b"moov", box(b"trak", mdia))


class Mp4SampleMapTests(unittest.TestCase):
    def test_valid_chunk_runs_expand_expected_offsets(self):
        data = fixture([(1, 1, 1), (2, 1, 1)])
        sizes, offsets = mp4_samples.parse_track_samples(data)
        self.assertEqual(sizes, [5, 5])
        self.assertEqual(offsets, [100, 120])

    def test_duplicate_or_descending_first_chunk_is_rejected(self):
        for rows in ([(1, 1, 1), (1, 1, 1)], [(2, 1, 1), (1, 1, 1)]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                mp4_samples.parse_track_samples(fixture(rows))

    def test_first_chunk_past_chunk_count_is_rejected_before_run_expansion(self):
        rows = [(1, 1, 1), (0xFFFFFFFF, 1, 1)]
        original_range = range

        def bounded_range(*args):
            value = original_range(*args)
            if len(value) > 100:
                raise AssertionError("parser attempted an unbounded stsc range")
            return value

        with patch.object(mp4_samples, "range", bounded_range, create=True):
            with self.assertRaises(ValueError):
                mp4_samples.parse_track_samples(fixture(rows))

    def test_first_chunk_must_be_one_and_each_entry_must_address_a_chunk(self):
        for rows in ([(2, 1, 1)], [(1, 1, 1), (3, 1, 1)]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                mp4_samples.parse_track_samples(fixture(rows))


if __name__ == "__main__":
    unittest.main()
