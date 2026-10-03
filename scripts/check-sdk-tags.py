#!/usr/bin/env python3
"""Validate OpenWrt versions and confirm every release SDK tag exists."""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


VERSION_PATTERNS = {
    "apk": re.compile(r"25\.12\.[0-9]+\Z"),
    "ipk": re.compile(r"24\.10\.[0-9]+\Z"),
}
MANIFEST_ACCEPT = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)


def fail(message: str) -> None:
    raise SystemExit(f"SDK tag check error: {message}")


def get_token() -> str:
    query = urllib.parse.urlencode(
        {
            "service": "ghcr.io",
            "scope": "repository:openwrt/sdk:pull",
        }
    )
    request = urllib.request.Request(
        f"https://ghcr.io/token?{query}",
        headers={"User-Agent": "luci-app-lucky-build-check"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = json.load(response)
    token = payload.get("token")
    if not isinstance(token, str) or not token:
        fail("GHCR returned no pull token")
    return token


def check_tag(tag: str, token: str) -> tuple[str, str]:
    request = urllib.request.Request(
        f"https://ghcr.io/v2/openwrt/sdk/manifests/{tag}",
        method="HEAD",
        headers={
            "Accept": MANIFEST_ACCEPT,
            "Authorization": f"Bearer {token}",
            "User-Agent": "luci-app-lucky-build-check",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}")
            digest = response.headers.get("Docker-Content-Digest", "")
    except (OSError, urllib.error.HTTPError, urllib.error.URLError) as exc:
        raise RuntimeError(f"ghcr.io/openwrt/sdk:{tag}: {exc}") from exc
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise RuntimeError(f"ghcr.io/openwrt/sdk:{tag}: invalid digest {digest!r}")
    return tag, digest


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("matrix", type=Path)
    parser.add_argument("--apk-version", required=True)
    parser.add_argument("--ipk-version", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()

    versions = {"apk": args.apk_version, "ipk": args.ipk_version}
    for package_format, version in versions.items():
        if not VERSION_PATTERNS[package_format].fullmatch(version):
            fail(f"invalid {package_format.upper()} OpenWrt version: {version!r}")

    try:
        matrix = json.loads(args.matrix.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(str(exc))

    targets = [
        (
            package_format,
            entry["package_arch"],
            f"{entry['package_arch']}-{versions[package_format]}",
        )
        for package_format in ("apk", "ipk")
        for entry in matrix[package_format]
    ]
    token = get_token()
    try:
        with ThreadPoolExecutor(max_workers=8) as executor:
            checked = dict(
                executor.map(
                    lambda tag: check_tag(tag, token),
                    (target[2] for target in targets),
                )
            )
    except RuntimeError as exc:
        fail(str(exc))

    lock_entries = [
        {
            "format": package_format,
            "package_arch": package_arch,
            "tag": tag,
            "digest": checked[tag],
            "image": f"ghcr.io/openwrt/sdk@{checked[tag]}",
        }
        for package_format, package_arch, tag in targets
    ]
    if args.output:
        lock = {
            "schema_version": 1,
            "apk_version": args.apk_version,
            "ipk_version": args.ipk_version,
            "sdk_images": lock_entries,
        }
        args.output.write_text(
            json.dumps(lock, indent=2) + "\n",
            encoding="utf-8",
        )

    print(
        f"validated {len(lock_entries)} OpenWrt SDK tags on "
        "ghcr.io/openwrt/sdk"
    )


if __name__ == "__main__":
    main()
