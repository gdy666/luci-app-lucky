#!/usr/bin/env python3
"""Validate the release architecture matrix used by GitHub Actions."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


EXPECTED_ARCHITECTURES = {
    "apk": (
        "aarch64_cortex-a53",
        "aarch64_cortex-a72",
        "aarch64_cortex-a76",
        "aarch64_generic",
        "arm_arm1176jzf-s_vfp",
        "arm_arm926ej-s",
        "arm_cortex-a15_neon-vfpv4",
        "arm_cortex-a5_vfpv4",
        "arm_cortex-a7",
        "arm_cortex-a7_neon-vfpv4",
        "arm_cortex-a7_vfpv4",
        "arm_cortex-a8_vfpv3",
        "arm_cortex-a9",
        "arm_cortex-a9_neon",
        "arm_cortex-a9_vfpv3-d16",
        "arm_xscale",
        "i386_pentium-mmx",
        "i386_pentium4",
        "mips_24kc",
        "mips_mips32",
        "mipsel_24kc",
        "mipsel_24kc_24kf",
        "mipsel_74kc",
        "mipsel_mips32",
        "riscv64_generic",
        "x86_64",
    ),
    "ipk": (
        "aarch64_cortex-a53",
        "aarch64_cortex-a72",
        "aarch64_cortex-a76",
        "aarch64_generic",
        "arm_arm1176jzf-s_vfp",
        "arm_arm926ej-s",
        "arm_cortex-a15_neon-vfpv4",
        "arm_cortex-a5_vfpv4",
        "arm_cortex-a7",
        "arm_cortex-a7_neon-vfpv4",
        "arm_cortex-a7_vfpv4",
        "arm_cortex-a8_vfpv3",
        "arm_cortex-a9",
        "arm_cortex-a9_neon",
        "arm_cortex-a9_vfpv3-d16",
        "arm_xscale",
        "i386_pentium-mmx",
        "i386_pentium4",
        "mips_24kc",
        "mips_4kec",
        "mips_mips32",
        "mipsel_24kc",
        "mipsel_24kc_24kf",
        "mipsel_74kc",
        "mipsel_mips32",
        "riscv64_riscv64",
        "x86_64",
    ),
}


def fail(message: str) -> None:
    raise SystemExit(f"build matrix error: {message}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("matrix", type=Path)
    args = parser.parse_args()

    try:
        data = json.loads(args.matrix.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(str(exc))

    if set(data) != set(EXPECTED_ARCHITECTURES):
        fail("top-level keys must be exactly apk and ipk")

    for package_format, expected_architectures in EXPECTED_ARCHITECTURES.items():
        entries = data[package_format]
        if not isinstance(entries, list):
            fail(f"{package_format} must be an array")
        expected_count = len(expected_architectures)
        if len(entries) != expected_count:
            fail(
                f"{package_format} must contain {expected_count} entries, "
                f"found {len(entries)}"
            )

        architectures: list[str] = []
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict) or set(entry) != {"package_arch"}:
                fail(
                    f"{package_format}[{index}] must contain only package_arch"
                )
            architecture = entry["package_arch"]
            if not isinstance(architecture, str):
                fail(
                    f"{package_format}[{index}] has unsupported architecture "
                    f"{architecture!r}"
                )
            architectures.append(architecture)

        if len(architectures) != len(set(architectures)):
            fail(f"{package_format} contains duplicate architectures")
        if architectures != sorted(architectures):
            fail(f"{package_format} architectures must be sorted")
        if tuple(architectures) != expected_architectures:
            missing = sorted(set(expected_architectures) - set(architectures))
            unexpected = sorted(set(architectures) - set(expected_architectures))
            fail(
                f"{package_format} differs from the reviewed architecture set; "
                f"missing={missing}, unexpected={unexpected}"
            )

    print(
        f"validated {len(data['apk'])} APK and {len(data['ipk'])} IPK "
        "package architectures"
    )


if __name__ == "__main__":
    main()
