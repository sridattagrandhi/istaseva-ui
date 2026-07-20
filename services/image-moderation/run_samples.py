#!/usr/bin/env python3
"""
CLI to test the moderation pipeline on local images — no server needed.

Examples:
    python run_samples.py path/to/image.jpg
    python run_samples.py ./test_images/

Prints a table: filename | verdict | nsfw | reasons
"""

from __future__ import annotations

import argparse
import os
import sys

from moderation.service import get_moderator

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def collect(paths: list[str]) -> list[str]:
    files: list[str] = []
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if os.path.splitext(name)[1].lower() in IMG_EXTS:
                    files.append(os.path.join(p, name))
        elif os.path.isfile(p):
            files.append(p)
        else:
            print(f"  (skip, not found: {p})", file=sys.stderr)
    return files


def main() -> int:
    ap = argparse.ArgumentParser(description="Run image moderation on local files.")
    ap.add_argument("paths", nargs="+", help="image files or directories")
    args = ap.parse_args()

    files = collect(args.paths)
    if not files:
        print("No images found.", file=sys.stderr)
        return 2

    mod = get_moderator()
    print(f"{'file':40} {'verdict':7} {'nsfw':>6}  reasons")
    print("-" * 80)
    for path in files:
        with open(path, "rb") as fh:
            data = fh.read()
        try:
            r = mod.moderate(data)
        except Exception as exc:  # noqa: BLE001
            print(f"{os.path.basename(path):40} ERROR   {exc}")
            continue
        s = r["scores"]
        name = os.path.basename(path)[:40]
        print(f"{name:40} {r['verdict']:7} {s['nsfw']:6.3f}  {','.join(r['reasons'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
