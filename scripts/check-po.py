#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Reject duplicate non-empty msgids in a PO file."""

import ast
import pathlib
import re
import sys


def read_msgids(path: pathlib.Path):
    current = None
    collecting = False

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("msgid "):
            if current:
                yield current
            current = ast.literal_eval(line[6:])
            collecting = True
        elif collecting and line.startswith('"'):
            current += ast.literal_eval(line)
        elif line and not line.startswith("#"):
            collecting = False

    if current:
        yield current


def main():
    path = pathlib.Path(sys.argv[1])
    seen = set()
    duplicates = set()

    for msgid in read_msgids(path):
        if msgid in seen:
            duplicates.add(msgid)
        seen.add(msgid)

    if duplicates:
        for msgid in sorted(duplicates):
            print(f"duplicate msgid: {msgid}", file=sys.stderr)
        return 1

    if len(sys.argv) > 2:
        javascript = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
        used = set(re.findall(r"_\('([^']*)'\)", javascript))
        missing = used - seen
        unused = seen - used
        if missing or unused:
            for msgid in sorted(missing):
                print(f"missing translation: {msgid}", file=sys.stderr)
            for msgid in sorted(unused):
                print(f"unused translation: {msgid}", file=sys.stderr)
            return 1

    print(f"PO check passed: {len(seen)} unique messages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
