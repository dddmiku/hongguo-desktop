"""Offline login-session contracts; credential fixtures are generated and synthetic."""
import ast
from pathlib import Path
import re
import time
import types
import unittest
from unittest.mock import Mock

from requests.structures import CaseInsensitiveDict


def synthetic_ascii(length=96):
    """No real credentials or credential-shaped literals are stored in this test."""
    return "".join(chr(65 + index % 26) for index in range(length))


class DesktopAccountSessionTests(unittest.TestCase):
    def setUp(self):
        # Match the existing provider leaf tests: exercise real source functions
        # without importing signer/config runtimes or touching a real session.
        source = Path(__file__).resolve().parents[1] / "vendor" / "desktop_account.py"
        parsed = ast.parse(source.read_text(encoding="utf-8"))
        selected = {"_extract_session", "_finish_login", "is_logged_in", "_headers"}
        functions = [node for node in parsed.body
                     if isinstance(node, ast.FunctionDef) and node.name in selected]
        self.saved = Mock()
        self.network = Mock(return_value={"data": {}})
        self.current = {}
        namespace = {
            "re": re, "time": time, "save_session": self.saved,
            "log_event": Mock(), "_call": self.network, "_json": lambda value: value,
            "clear_mfa": Mock(), "load_session": lambda: self.current,
            "PASSPORT_HOST": "synthetic-host", "mask_mobile": lambda value: "",
            "H": types.SimpleNamespace(CFG={"session_headers": {}}),
            "public_session": lambda session: {
                "loggedIn": bool(session.get("cookie") or session.get("token"))},
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(source), "exec"), namespace)
        self.extract = namespace["_extract_session"]
        self.finish = namespace["_finish_login"]
        self.logged_in = namespace["is_logged_in"]
        self.headers = namespace["_headers"]

    @staticmethod
    def response(headers=None, data=None, cookie=False):
        jar = [types.SimpleNamespace(name="sessionid", value=synthetic_ascii(48))] if cookie else []
        return types.SimpleNamespace(
            headers={} if headers is None else headers, cookies=jar, status_code=200,
            json=Mock(return_value={"message": "success", "data": data or {}}))

    def test_header_only_login_preserves_token_in_saved_session(self):
        expected = synthetic_ascii()
        result = self.finish(self.response({"x-tt-token": expected}, cookie=True), "")
        saved = self.saved.call_args.args[0]
        # Boolean comparisons keep synthetic credential contents out of failures.
        self.assertTrue(saved.get("token") == expected)
        self.assertTrue(bool(saved.get("cookie")))
        self.assertTrue(result["session"]["loggedIn"])
        self.network.assert_called_once()

    def test_response_header_accepts_import_length_boundary(self):
        expected = synthetic_ascii(8192)
        result = self.extract(self.response({"x-tt-token": expected}), {})
        self.assertTrue(result.get("token") == expected)

    def test_invalid_header_never_replaces_existing_session_token(self):
        previous = synthetic_ascii(72)
        invalid = {
            "empty": "", "whitespace": chr(32) * 3,
            "over_limit": synthetic_ascii(8193),
            "space_inside": synthetic_ascii(24) + chr(32) + synthetic_ascii(24),
            "null": synthetic_ascii(24) + chr(0),
            "tab": synthetic_ascii(24) + chr(9),
            "lf": synthetic_ascii(24) + chr(10),
            "cr": synthetic_ascii(24) + chr(13),
            "del": synthetic_ascii(24) + chr(127),
            "non_ascii": synthetic_ascii(24) + chr(0x2603),
            "not_string": 7,
        }
        for name, value in invalid.items():
            with self.subTest(case=name):
                result = self.extract(self.response({"x-tt-token": value}), {"token": previous})
                self.assertTrue(result.get("token") == previous)

    def test_header_lookup_ignores_case_in_supported_header_mappings(self):
        expected = synthetic_ascii()
        previous = synthetic_ascii(72)
        mappings = {"plain": dict, "case_insensitive": CaseInsensitiveDict}
        for name, mapping in mappings.items():
            for key in ("x-tt-token", "X-TT-TOKEN", "X-Tt-Token", "x-tT-ToKeN"):
                with self.subTest(mapping=name, header=key):
                    result = self.extract(self.response(mapping({key: expected})), {"token": previous})
                    self.assertTrue(result.get("token") == expected)

    def test_existing_body_token_priority_is_unchanged(self):
        keys = ("token", "session_key", "x_tt_token", "x-tt-token")
        for first in range(len(keys)):
            with self.subTest(first_body_key=keys[first]):
                data = {key: "" for key in keys}
                for index in range(first, len(keys)):
                    data[keys[index]] = synthetic_ascii(80 + index)
                result = self.extract(
                    self.response({"x-tt-token": synthetic_ascii(128)}, data=data),
                    {"token": synthetic_ascii(72)})
                self.assertTrue(result.get("token") == data[keys[first]])

    def test_cookie_only_existing_session_remains_unchanged_and_logged_in(self):
        previous = {"cookie": synthetic_ascii(48)}
        result = self.extract(self.response(), previous)
        self.assertTrue(result.get("cookie") == previous["cookie"])
        self.assertFalse(result.get("token"))
        self.current = result
        self.assertTrue(self.logged_in())
        headers = self.headers(result)
        self.assertTrue(headers.get("cookie") == previous["cookie"])
        self.assertNotIn("x-tt-token", headers)

    def test_cookie_only_new_login_remains_valid_without_inventing_token(self):
        result = self.finish(self.response(cookie=True), "")
        saved = self.saved.call_args.args[0]
        self.assertTrue(result["session"]["loggedIn"])
        self.assertTrue(bool(saved.get("cookie")))
        self.assertFalse(saved.get("token"))
        self.assertNotIn("x-tt-token", self.headers(saved))


if __name__ == "__main__":
    unittest.main()
