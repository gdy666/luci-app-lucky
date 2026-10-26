#!/usr/bin/env python3
"""Check cache isolation, non-disruptive ACL refresh and offline builds."""
from pathlib import Path
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
source = (root / 'luci-app-lucky/root/usr/libexec/lucky-luci-refresh').read_text()
with tempfile.TemporaryDirectory(prefix='lucky-menu-') as work:
    work = Path(work)
    cache = work / 'tmp'
    cache.mkdir()
    commands = work / 'commands'
    commands.mkdir()
    calls = work / 'calls'
    fallback = commands / 'lua'
    fallback.write_text('#!/bin/sh\nprintf "acl:%s\\n" "$*" >> "$CALLS"\nexit "${ACL_EXIT:-0}"\n')
    fallback.chmod(0o755)
    helper = work / 'refresh'
    assert '/etc/init.d/' not in source and 'killall' not in source
    helper.write_text(source.replace('/tmp/luci-', str(cache / 'luci-')))
    env = dict(os.environ, PATH=str(commands) + ':' + os.environ['PATH'], CALLS=str(calls))
    env.pop('IPKG_INSTROOT', None)

    def seed():
        (cache / 'luci-indexcache').write_text('old')
        (cache / 'luci-indexcache.test.json').write_text('old')
        (cache / 'luci-modulecache').mkdir(exist_ok=True)
        (cache / 'luci-modulecache/module').write_text('old')
        (cache / 'unrelated').write_text('keep')
        calls.write_text('')

    seed()
    subprocess.run(['sh', str(helper)], env=dict(env, IPKG_INSTROOT='/offline'), check=True, capture_output=True)
    assert (cache / 'luci-indexcache').exists() and calls.read_text() == ''
    for running in [True, False]:
        seed()
        subprocess.run(['sh', str(helper)], env=dict(env, ACL_EXIT=str(int(not running))), check=True, capture_output=True)
        assert not list(cache.glob('luci-*'))
        assert (cache / 'unrelated').read_text() == 'keep'
        assert calls.read_text() == 'acl:/usr/lib/lua/luci/lucky_menu.lua\n'
print('PASS: offline build isolation, both cache formats, no service restart or signal, ACL failure and unrelated files preserved')
