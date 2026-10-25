#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Exercise translation postinst with old/new uci-defaults ordering and retries."""

import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile


root = Path(__file__).resolve().parent.parent
makefile = (root / 'luci-app-lucky/Makefile').read_text(encoding='utf-8')
match = re.search(r'^override define Package/luci-i18n-lucky-zh-cn/postinst\n(.*?)\nendef$',
                  makefile, re.M | re.S)
assert match, 'Keep the package override ahead of the SDK luci.mk include'
assert match.end() < makefile.index('include $(TOPDIR)/feeds/luci/luci.mk')
hook = match.group(1).replace('$$', '$')

with tempfile.TemporaryDirectory(prefix='lucky-i18n-') as temp:
    work = Path(temp)
    defaults = work / 'uci-defaults' / 'luci-i18n-lucky-zh-cn'
    defaults.parent.mkdir()
    count = work / 'executions'
    postinst = work / 'postinst-pkg'
    postinst.write_text(hook.replace('/etc/uci-defaults/luci-i18n-lucky-zh-cn',
                                    shlex.quote(str(defaults))) + '\n')

    def prepare(fail=False):
        defaults.write_text('printf "registered\\n" >> ' + shlex.quote(str(count)) +
                            ('\nexit 7\n' if fail else '\n'))

    def run(offline=False):
        env = dict(os.environ, IPKG_INSTROOT=str(work / 'offline root') if offline else '')
        return subprocess.run(['sh', str(postinst)], env=env, capture_output=True, text=True)

    def check(result, code=0):
        assert result.returncode == code, (result.returncode, result.stderr)
        assert not result.stderr, result.stderr

    # Older firmware leaves uci-defaults execution to the package.
    prepare()
    check(run())
    assert not defaults.exists()
    assert count.read_text().splitlines() == ['registered']
    check(run())
    assert count.read_text().splitlines() == ['registered']

    # Newer firmware already ran and removed it before postinst-pkg.
    prepare()
    subprocess.run(['sh', str(defaults)], check=True)
    defaults.unlink()
    check(run())
    assert count.read_text().splitlines() == ['registered', 'registered']

    # Offline image builds must leave the script for first boot.
    prepare()
    check(run(offline=True))
    assert defaults.is_file()
    assert len(count.read_text().splitlines()) == 2

    # A failed initialization must remain retryable and report failure.
    prepare(fail=True)
    check(run(), code=7)
    assert defaults.is_file()
    prepare()
    check(run())
    assert not defaults.exists()

print('PASS: old/new firmware ordering, repeated postinst, offline image, failure and retry')
