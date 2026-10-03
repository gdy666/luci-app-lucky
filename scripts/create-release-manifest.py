#!/usr/bin/env python3
"""Create a deterministic manifest for the aggregated OpenWrt packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("packages", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--source-fingerprint", required=True)
    parser.add_argument("--source-dirty", action="store_true")
    args = parser.parse_args()

    entries: list[dict[str, object]] = []
    for package in sorted(args.packages.rglob("*")):
        if package.suffix not in {".apk", ".ipk"}:
            continue
        relative = package.relative_to(args.packages)
        parts = relative.parts
        if len(parts) != 4 or not parts[0].startswith("openwrt-"):
            raise SystemExit(f"unexpected package path: {relative}")

        release = parts[0].removeprefix("openwrt-")
        package_format = parts[1]
        package_arch = parts[2]
        if package_format != package.suffix[1:]:
            raise SystemExit(f"package format mismatch: {relative}")

        metadata_name = (
            "SDK-METADATA.txt" if package_arch == "all" else "PACKAGE-METADATA.txt"
        )
        metadata_path = package.parent / metadata_name
        try:
            metadata = dict(
                line.split("\t", 1)
                for line in metadata_path.read_text(encoding="utf-8").splitlines()
                if "\t" in line
            )
        except OSError as exc:
            raise SystemExit(f"missing SDK metadata for {relative}: {exc}") from exc
        sdk_image = metadata.get("SDK-Image", "")
        source_fingerprint = metadata.get("Source-Fingerprint", "")
        if not re.fullmatch(
            r"ghcr\.io/openwrt/sdk@sha256:[0-9a-f]{64}", sdk_image
        ):
            raise SystemExit(f"invalid SDK image metadata for {relative}")
        if source_fingerprint != args.source_fingerprint:
            raise SystemExit(f"source fingerprint mismatch for {relative}")

        entries.append(
            {
                "file": relative.as_posix(),
                "format": package_format,
                "openwrt_release": release,
                "package_arch": package_arch,
                "sdk_tag": f"{'x86_64' if package_arch == 'all' else package_arch}-{release}",
                "sdk_digest": sdk_image.partition("@")[2],
                "sha256": sha256(package),
                "size": package.stat().st_size,
            }
        )

    if not entries:
        raise SystemExit("no APK or IPK packages found")

    manifest = {
        "schema_version": 1,
        "git_commit": args.commit,
        "source_fingerprint": args.source_fingerprint,
        "source_dirty": args.source_dirty,
        "packages": entries,
    }
    args.output.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
