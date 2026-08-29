"""Convert assets/icon.png to a multi-size .ico (legacy entry point)."""
from __future__ import annotations

import os
import subprocess
import sys


def main() -> int:
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    export = os.path.join(root, "scripts", "export-icons.py")
    return subprocess.call([sys.executable, export])


if __name__ == "__main__":
    raise SystemExit(main())
