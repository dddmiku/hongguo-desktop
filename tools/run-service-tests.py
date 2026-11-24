"""Run offline service tests with the production media runtime when host PyAV is absent."""
import argparse
import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import sysconfig
import unittest

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pattern", default="test_*.py")
    parser.add_argument("--dependencies", help=argparse.SUPPRESS)
    args = parser.parse_args()
    embedded = ROOT / "runtime" / "python" / "python.exe"
    if importlib.util.find_spec("av") is None and embedded.is_file() and Path(sys.executable).resolve() != embedded.resolve():
        work = ROOT / "_work" / "python-suite"
        work.mkdir(parents=True, exist_ok=True)
        environment = dict(os.environ, TEMP=str(work), TMP=str(work))
        command = [str(embedded), "-B", str(Path(__file__).resolve()), "--pattern", args.pattern,
                   "--dependencies", sysconfig.get_path("purelib")]
        return subprocess.run(command, cwd=ROOT, env=environment).returncode
    sys.path.insert(0, str(ROOT))
    if args.dependencies and importlib.util.find_spec("httpx2") is None and importlib.util.find_spec("httpx") is None:
        # TestClient's optional pure-Python client stays last. The production
        # PyAV/crypto/native modules must remain authoritative.
        sys.path.append(args.dependencies)
    suite = unittest.defaultTestLoader.discover(str(ROOT / "service" / "tests"), pattern=args.pattern)
    return int(not unittest.TextTestRunner(verbosity=1).run(suite).wasSuccessful())


if __name__ == "__main__":
    sys.exit(main())
