#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
	echo "Usage: $0 OPENWRT_SDK_DIR [REPOSITORY_DIR]" >&2
	exit 2
fi

sdk_dir="$(cd "$1" && pwd)"
repo_dir="$(cd "${2:-$(dirname "$0")/..}" && pwd)"
build_luci="${LUCKY_BUILD_LUCI:-1}"
make_jobs="${LUCKY_MAKE_JOBS:-}"

case "$build_luci" in
0 | 1) ;;
*)
	echo "LUCKY_BUILD_LUCI must be 0 or 1" >&2
	exit 2
	;;
esac
if [ -n "$make_jobs" ] && ! [[ $make_jobs =~ ^[1-9][0-9]*$ ]]; then
	echo "LUCKY_MAKE_JOBS must be a positive integer" >&2
	exit 2
fi

cd "$sdk_dir"
make_args=()
if [ -n "$make_jobs" ]; then
	make_args+=("-j$make_jobs")
fi
legacy_sdk=0
if [ "${OPENWRT_FORCE:-0}" = "1" ]; then
	if ! grep -Eq '^VERSION_NUMBER:=.*19\.07\.' include/version.mk; then
		echo "OPENWRT_FORCE=1 is restricted to an OpenWrt 19.07 SDK" >&2
		exit 2
	fi
	mkdir -p staging_dir/host
	touch staging_dir/host/.prereq-build
	make_args+=("FORCE=1")
	legacy_sdk=1
fi

[ -f feeds.conf ] || cp feeds.conf.default feeds.conf
feed_line="src-link lucky $repo_dir"
if grep -q '^src-link lucky ' feeds.conf; then
	grep -Fxq "$feed_line" feeds.conf || {
		echo "feeds.conf already contains a different src-link lucky path" >&2
		exit 2
	}
else
	printf '%s\n' "$feed_line" >> feeds.conf
fi

./scripts/feeds update -a
feed_packages=(lucky)
if [ "$build_luci" = "1" ]; then
	feed_packages+=(luci-app-lucky)
fi
./scripts/feeds install -p lucky -f "${feed_packages[@]}"
if [ "$legacy_sdk" = "1" ]; then
	legacy_luci_makefile="feeds/luci/modules/luci-base/src/Makefile"
	if grep -Eq '^[[:space:]]*cc -o contrib/lemon ' "$legacy_luci_makefile"; then
		sed -i 's|^\([[:space:]]*\)cc -o contrib/lemon |\1cc -std=gnu89 -o contrib/lemon |' "$legacy_luci_makefile"
	elif ! grep -Eq '^[[:space:]]*cc -std=gnu89 -o contrib/lemon ' "$legacy_luci_makefile"; then
		echo "Unexpected OpenWrt 19.07 luci-base host build rule" >&2
		exit 2
	fi
fi
touch .config
sed -i '/^CONFIG_PACKAGE_lucky=/d; /^# CONFIG_PACKAGE_lucky is not set$/d' .config
sed -i '/^CONFIG_PACKAGE_luci-app-lucky=/d; /^# CONFIG_PACKAGE_luci-app-lucky is not set$/d' .config
printf '%s\n' CONFIG_PACKAGE_lucky=m >> .config
if [ "$build_luci" = "1" ]; then
	printf '%s\n' CONFIG_PACKAGE_luci-app-lucky=m >> .config
fi
make defconfig "${make_args[@]}"
make package/feeds/lucky/lucky/compile V=s "${make_args[@]}"
if [ "$build_luci" = "1" ]; then
	make package/feeds/lucky/luci-app-lucky/compile V=s "${make_args[@]}"
fi

find bin/packages -type f \( -name '*lucky*.ipk' -o -name '*lucky*.apk' \) -print
