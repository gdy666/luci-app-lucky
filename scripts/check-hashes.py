#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Validate that every supported Lucky asset has a SHA-256 hash."""

import argparse
import hashlib
import pathlib
import re
import sys
import urllib.request


EXPECTED = {
    "arm64",
    "armv5",
    "armv6",
    "armv7",
    "i386",
    "mipsle_hardfloat",
    "mipsle_softfloat",
    "mips_hardfloat",
    "mips_softfloat",
    "riscv64",
    "x86_64",
}


def verify_remote(version, hashes):
    base = f"https://github.com/gdy666/lucky/releases/download/v{version}"
    for architecture in sorted(hashes):
        url = f"{base}/lucky_{version}_Linux_{architecture}.tar.gz"
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=60) as response:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
        actual = digest.hexdigest()
        if actual != hashes[architecture]:
            raise ValueError(f"hash mismatch for {architecture}: {actual}")
        print(f"Remote hash passed: {architecture}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("makefile", type=pathlib.Path)
    parser.add_argument("--verify-remote", action="store_true")
    args = parser.parse_args()

    text = args.makefile.read_text(encoding="utf-8")
    entries = re.findall(r"^LUCKY_HASH_([A-Za-z0-9_]+):=([0-9a-f]{64})$", text, re.MULTILINE)
    hashes = dict(entries)
    missing = EXPECTED - hashes.keys()
    extra = hashes.keys() - EXPECTED

    if len(entries) != len(hashes):
        print("duplicate LUCKY_HASH declarations found", file=sys.stderr)
        return 1

    required_lines = {
        "PKG_SOURCE:=lucky_$(PKG_VERSION)_Linux_$(LUCKY_ARCH).tar.gz",
        "PKG_HASH:=$(LUCKY_HASH_$(LUCKY_ARCH))",
    }
    missing_lines = required_lines - set(text.splitlines())

    if re.search(r"^PKG_HASH\s*:?=\s*skip\s*$", text, re.MULTILINE):
        print("PKG_HASH must not be skip", file=sys.stderr)
        return 1

    if missing or extra or missing_lines:
        if missing:
            print("missing hashes: " + ", ".join(sorted(missing)), file=sys.stderr)
        if extra:
            print("unexpected hashes: " + ", ".join(sorted(extra)), file=sys.stderr)
        if missing_lines:
            print("missing package mapping: " + ", ".join(sorted(missing_lines)), file=sys.stderr)
        return 1

    print(f"Hash check passed: {len(hashes)} assets")
    if args.verify_remote:
        version_match = re.search(r"^PKG_VERSION:=([^\s]+)$", text, re.MULTILINE)
        if not version_match:
            print("PKG_VERSION is missing", file=sys.stderr)
            return 1
        try:
            verify_remote(version_match.group(1), hashes)
        except (OSError, ValueError) as error:
            print(str(error), file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
