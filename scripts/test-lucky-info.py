"""Core/base-info cache regression tests on a disposable localhost OpenWrt VM.

Runs real Lua/nixio child processes against private fixture executables. The
installed Lucky core, service and configuration are never replaced or stopped.
"""
import argparse
import concurrent.futures
import json
import shlex
import time
from pathlib import Path

import paramiko

parser = argparse.ArgumentParser()
parser.add_argument('--vm-port', type=int, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect('127.0.0.1', port=args.vm_port, username='root', password='',
                   allow_agent=False, look_for_keys=False)
except paramiko.AuthenticationException:
    client.get_transport().auth_none('root')


def command(value, check=True):
    stdin, stdout, stderr = client.exec_command(value)
    data, error = stdout.read(), stderr.read()
    code = stdout.channel.recv_exit_status()
    stdin.close(); stdout.close(); stderr.close()
    if check:
        assert code == 0, (value, code, error)
    return data


def put(path, data, mode=0o600):
    stdin, stdout, stderr = client.exec_command('cat > ' + shlex.quote(path) +
                                               ' && chmod ' + oct(mode)[2:] + ' ' + shlex.quote(path))
    stdin.write(data if isinstance(data, bytes) else data.encode())
    stdin.flush(); stdin.channel.shutdown_write()
    code, error = stdout.channel.recv_exit_status(), stderr.read()
    stdin.close(); stdout.close(); stderr.close()
    assert code == 0, (path, error)


work = command('mktemp -d /tmp/lucky-info-test.XXXXXX').decode().strip()
binary, cache, count = (work + '/' + name for name in ('lucky', 'info.json', 'count'))
started, driver = work + '/started', work + '/driver.lua'
base_cache, selected = work + '/base.json', work + '/selected-dir'
setter = work + '/setter'
config_dir = work + "/config with 'quotes'"
config_file = config_dir + '/lucky_base.lkcf'
before = command('sha256sum /usr/bin/lucky /etc/config/lucky')
pid_before = command('pidof lucky', False)
originals = {}


def call(operation='core-info', memory=None, fail_write=False, fixed_stat=False, config_setter=False,
         invalidate_race=False):
    env = '' if memory is None else 'LUCKY_TEST_MEMORY=' + str(memory) + ' '
    if fail_write:
        env += 'LUCKY_TEST_WRITE_FAIL=1 '
    if fixed_stat:
        env += 'LUCKY_TEST_FIXED_STAT=1 '
    if config_setter:
        env += 'LUCKY_TEST_SETTER=' + shlex.quote(setter) + ' '
    if invalidate_race:
        env += 'LUCKY_TEST_INVALIDATE_RACE=' + shlex.quote(base_cache) + ' '
    words = [operation] if isinstance(operation, str) else operation
    return json.loads(command(env + 'lua ' + shlex.quote(driver) + ' ' + ' '.join(map(shlex.quote, words))))


def executions():
    return len(command('cat ' + shlex.quote(count), False).splitlines())


def remove_cache():
    command('rm -f ' + shlex.quote(cache))


def program(version='3.2.3', delay=0, body=None, extra='', dest=None):
    response = json.dumps({'Version': version, 'Date': 'test-build'})
    script = ('#!/bin/sh\nprintf "query\\n" >> ' + shlex.quote(count) + '\n'
              'touch ' + shlex.quote(started) + '\n')
    if delay:
        script += 'sleep ' + str(delay) + '\n'
    script += (body if body is not None else "printf '%s\\n' " + shlex.quote(response))
    put(dest or binary, script + '\n# ' + extra + '\n', 0o700)


def wait_started():
    for _ in range(100):
        if command('test -e ' + shlex.quote(started) + ' && echo yes', False).strip():
            return
        time.sleep(0.05)
    raise AssertionError('fixture core never started')


try:
    for name in ('root/usr/lib/lua/luci/lucky_core.lua', 'root/usr/libexec/lucky-backup'):
        target = '/' + name.removeprefix('root/')
        originals[target] = command('cat ' + shlex.quote(target))
        put(target, (root / 'luci-app-lucky' / name).read_bytes().replace(b'\r\n', b'\n'),
            0o755 if '/libexec/' in target else 0o644)
    # Override paths in this short-lived test process, never in installed code.
    put(driver, '''local c = require "luci.lucky_core"
local function replace(fn, name, value, seen)
 seen = seen or {}; if seen[fn] then return false end; seen[fn] = true
 for i = 1, 100 do
  local k, v = debug.getupvalue(fn, i); if not k then break end
  if k == name then debug.setupvalue(fn, i, value); return true end
  if type(v) == "function" and replace(v, name, value, seen) then return true end
 end
 return false
end
assert(replace(c.status, "BIN", %s))
assert(replace(c.status, "INFO_CACHE", %s))
assert(replace(c.status, "BASE_CACHE", %s))
assert(replace(c.status, "base_directory", function()
 local f = assert(io.open(%s)); local dir = f:read("*a"); f:close(); return dir
end))
local memory = tonumber(os.getenv("LUCKY_TEST_MEMORY"))
if memory then assert(replace(c.info, "available_memory", function() return memory end)) end
local invalidation = os.getenv("LUCKY_TEST_INVALIDATE_RACE")
if invalidation then
 local fs = require "nixio.fs"; local unlink = fs.unlink
 fs.unlink = function(path)
  if path == invalidation then unlink(path) end
  return unlink(path)
 end
end
if os.getenv("LUCKY_TEST_WRITE_FAIL") then
 local fs = require "nixio.fs"; local rename = fs.rename
 fs.rename = function(a, b) if b == %s or b == %s then return nil end; return rename(a, b) end
end
if os.getenv("LUCKY_TEST_FIXED_STAT") then
 local fs = require "nixio.fs"; local stat = fs.stat
 fs.stat = function(path)
  local st = stat(path)
  if st and path:match("/lucky_base%%.lkcf$") then st.mtime = 1; st.ctime = 1 end
  return st
 end
end
local setter = os.getenv("LUCKY_TEST_SETTER")
if setter then
 local file = assert(io.open("/usr/libexec/lucky-backup")); local source = file:read("*a"); file:close()
 local count
 source, count = source:gsub('local CONFIG_HELPER = "/usr/libexec/lucky%%-call"', function()
  return 'local CONFIG_HELPER = ' .. string.format("%%q", setter)
 end)
 assert(count == 1); source = source:gsub("^#!", "--"); assert(loadstring(source))()
else dofile("/usr/libexec/lucky-backup") end
''' % tuple(map(json.dumps, (binary, cache, base_cache, selected, cache, base_cache))))
    command('mkdir -p ' + shlex.quote(config_dir)); put(selected, config_dir)
    program()
    assert call('core-status').get('info') is None
    assert executions() == 0
    assert call()['Version'] == '3.2.3'
    stored = json.loads(command('cat ' + cache))
    assert stored['schema'] == 1 and stored['info']['Version'] == '3.2.3'
    mode_check = 'print(require("nixio.fs").stat(' + json.dumps(cache) + ').modedec)'
    assert command('lua -e ' + shlex.quote(mode_check)).strip() == b'600'
    for _ in range(3):
        assert call()['Version'] == '3.2.3'
        assert call('core-status')['info']['Date'] == 'test-build'
    assert executions() == 1
    print('PASS: cold query runs once; repeated queries/status reads reuse a private JSON cache', flush=True)

    n = executions()
    command('touch -m -t 202001010101 ' + binary)
    assert call('core-status').get('info') is None
    assert call()['Version'] == '3.2.3' and executions() == n + 1
    program('3.2.4', extra='size changed')
    assert call()['Version'] == '3.2.4' and executions() == n + 2
    candidate = work + '/new'
    program('3.2.5', extra='size changed', dest=candidate)
    command('touch -r ' + binary + ' ' + candidate + ' && mv ' + candidate + ' ' + binary)
    assert call('core-status').get('info') is None
    assert call()['Version'] == '3.2.5' and executions() == n + 3
    time.sleep(1.1)
    command('chmod 600 ' + binary + ' && chmod 700 ' + binary)
    assert call('core-status').get('info') is None
    assert call()['Version'] == '3.2.5' and executions() == n + 4
    print('PASS: size, mtime, ctime and same-size/same-mtime inode replacement invalidate the cache', flush=True)

    n = executions()
    assert call(memory=0)['Version'] == '3.2.5'
    assert call('core-status', memory=0)['info']['Version'] == '3.2.5'
    assert executions() == n
    remove_cache()
    rejected = call(memory=0)
    assert not rejected['ok'] and 'memory' in rejected['error']
    assert executions() == n
    assert call(memory=512 * 1024)['ok'] and executions() == n + 1
    print('PASS: low memory serves existing cache but cannot launch a fresh version query', flush=True)

    for damaged in ('{broken', 'x' * 5000, json.dumps({**stored, 'fingerprint': 'wrong'})):
        put(cache, damaged)
        assert call('core-status').get('info') is None
        n = executions(); assert call()['ok'] and executions() == n + 1
    command('chmod 666 ' + cache)
    assert call('core-status').get('info') is None
    assert call()['ok']
    sentinel = work + '/sentinel'; put(sentinel, 'preserve')
    remove_cache(); command('ln -s ' + sentinel + ' ' + cache)
    assert call('core-status').get('info') is None and call()['ok']
    assert command('cat ' + sentinel) == b'preserve'
    assert command('test ! -L ' + cache + ' && echo regular').strip() == b'regular'
    print('PASS: corrupt, oversized, stale, writable and symlink caches are not trusted', flush=True)

    for bad in ('echo not-json', 'echo \'{"Version":""}\'', 'exit 7'):
        remove_cache(); program(body=bad)
        assert not call()['ok']
        assert call('core-status').get('info') is None
        assert command('test -e ' + cache + ' && echo unexpected', False) == b''
    program(); assert call()['ok']
    remove_cache(); n = executions()
    assert call(fail_write=True)['Version'] == '3.2.3' and executions() == n + 1
    assert call('core-status').get('info') is None
    assert call()['ok'] and executions() == n + 2
    print('PASS: failed/invalid queries are not cached; failed cache writes do not hide valid information', flush=True)

    remove_cache(); command('rm -f ' + started); program(delay=2)
    n = executions()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(call); wait_started()
        begin = time.monotonic()
        assert call('core-status').get('info') is None
        assert time.monotonic() - begin < 1.5, 'status should not wait for a slow version query'
        second = pool.submit(call)
        assert first.result()['ok'] and second.result()['ok']
    assert executions() == n + 1
    print('PASS: concurrent cache misses share one core execution; status remains nonblocking', flush=True)

    remove_cache(); command('rm -f ' + started); program('3.2.6', delay=2)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(call); wait_started()
        program('3.2.7', dest=candidate)
        command('mv ' + candidate + ' ' + binary)
        result = pending.result()
        assert not result['ok'] and 'changed during' in result['error'], result
    assert call('core-status').get('info') is None
    assert call()['Version'] == '3.2.7'
    command('chmod 600 ' + binary)
    assert call('core-status')['status'] == 'permissions'
    assert call('core-status').get('info') is None and not call()['ok']
    command('rm ' + binary)
    assert call('core-status')['status'] == 'missing'
    assert call('core-status').get('info') is None and not call()['ok']
    print('PASS: replacement during a query discards its response; missing/non-executable cores hide stale metadata', flush=True)

    def config(port=16601, path=config_file, **extra):
        value = {'BaseConfigure': {'AdminWebListenPort': port, 'SafeURL': '/entry',
                                  'AllowInternetaccess': True, 'AdminPassword': 'must-not-cache', **extra}}
        put(path, json.dumps(value))

    def base_program(body=None):
        program(body='[ "$1" = -baseConfInfo ] && [ "$2" = -cd ] || exit 2\n' +
                (body or 'cat "$3/lucky_base.lkcf"'))

    config(); base_program(); n = executions()
    assert call('core-status').get('base') is None
    assert call('core-base')['BaseConfigure']['AdminWebListenPort'] == 16601
    stored_base = command('cat ' + base_cache)
    assert b'must-not-cache' not in stored_base and b'AdminPassword' not in stored_base
    for _ in range(3):
        assert call('core-base', memory=0)['BaseConfigure']['SafeURL'] == '/entry'
        assert call('core-status', memory=0)['base']['BaseConfigure']['AllowInternetaccess'] is True
    assert executions() == n + 1
    assert command('lua -e ' + shlex.quote('print(require("nixio.fs").stat(' + json.dumps(base_cache) + ').modedec)')).strip() == b'600'
    print('PASS: base queries cache only UI fields, handle quoted directories and work under low memory on cache hits', flush=True)

    # Simulate old-core same-size in-place writes in one timestamp tick.
    assert call('core-base', fixed_stat=True)['ok']; n = executions()
    config(port=16602)
    assert call('core-status', fixed_stat=True).get('base') is None
    assert call('core-base', fixed_stat=True)['BaseConfigure']['AdminWebListenPort'] == 16602
    assert executions() == n + 1
    assert call('core-base')['ok']; n = executions()
    command('touch -m -t 202001010101 ' + shlex.quote(config_file))
    assert call('core-status').get('base') is None
    assert call('core-base')['ok'] and executions() == n + 1
    config(port=16603, path=candidate)
    command('touch -r ' + shlex.quote(config_file) + ' ' + candidate + ' && mv ' + candidate + ' ' + shlex.quote(config_file))
    assert call('core-status').get('base') is None
    assert call('core-base')['BaseConfigure']['AdminWebListenPort'] == 16603
    other_dir = work + '/other-config'; command('mkdir ' + other_dir)
    config(port=16604, path=other_dir + '/lucky_base.lkcf'); put(selected, other_dir)
    assert call('core-status').get('base') is None
    assert call('core-base')['BaseConfigure']['AdminWebListenPort'] == 16604
    put(selected, config_dir)
    assert call('core-base')['BaseConfigure']['AdminWebListenPort'] == 16603
    command('touch -m -t 202001010101 ' + binary)
    assert call('core-status').get('base') is None
    assert not call('core-base', memory=0)['ok']
    assert call('core-base')['ok']
    print('PASS: config content, timestamps, inode replacement, directory switch and core upgrade invalidate base cache', flush=True)

    for damaged in ('{broken', 'x' * 17000, json.dumps({**json.loads(stored_base), 'fingerprint':'wrong'})):
        put(base_cache, damaged)
        assert call('core-status').get('base') is None and call('core-base')['ok']
    command('chmod 666 ' + base_cache)
    assert call('core-status').get('base') is None and call('core-base')['ok']
    command('rm ' + base_cache + ' && ln -s ' + sentinel + ' ' + base_cache)
    assert call('core-status').get('base') is None and call('core-base')['ok']
    assert command('cat ' + sentinel) == b'preserve'
    for invalid in ('echo not-json', 'echo \'{"BaseConfigure":{"AdminWebListenPort":0}}\'',
                    'echo \'{"BaseConfigure":{"AdminWebListenPort":16601,"SafeURL":[]}}\'', 'exit 7'):
        command('rm -f ' + base_cache); base_program(invalid)
        assert not call('core-base')['ok'] and call('core-status').get('base') is None
        assert command('test -e ' + base_cache + ' && echo unexpected', False) == b''
    base_program(); assert call('core-base', fail_write=True)['ok']
    assert call('core-status').get('base') is None
    assert call('core-base')['ok']
    print('PASS: unsafe caches and failed base responses are rejected; failed cache writes still return fresh data', flush=True)

    original_config = command('cat ' + shlex.quote(config_file))
    base_program('value="$(cat "$3/lucky_base.lkcf")"\n'
                 'printf "rewritten by old core" > "$3/lucky_base.lkcf"\n'
                 'echo "2026/10/14 12:00:00 init default base configure"\n'
                 'printf "%s\\n" "$value"')
    n = executions()
    assert call('core-base')['BaseConfigure']['AdminWebListenPort'] == 16603
    assert call('core-base')['ok'] and executions() == n + 1
    assert command('cat ' + shlex.quote(config_file)) == original_config
    assert command('test -e /tmp/lucky-luci-backup/base-query && echo leftover', False) == b''
    print('PASS: old-core initialization notices parse correctly; self-rewrites stay in an erased private snapshot', flush=True)

    command('rm -f ' + base_cache)
    base_program('yes too-large | head -c 140000')
    assert not call('core-base')['ok'] and call('core-status').get('base') is None
    assert command('test -e /tmp/lucky-luci-backup/base-query && echo leftover', False) == b''
    print('PASS: oversized query output fails cleanly and removes its private snapshot', flush=True)

    # A read must not undo a clear operation, even if an old core initializes
    # missing configuration as a side effect of -baseConfInfo.
    seed = work + '/seed'; config(path=seed)
    base_program('[ -f "$3/lucky_base.lkcf" ] || cp ' + seed + ' "$3/lucky_base.lkcf"\ncat "$3/lucky_base.lkcf"')
    assert call('core-base')['ok']; n = executions()
    command('rm ' + shlex.quote(config_file))
    assert call('core-status').get('base') is None
    rejected = call('core-base')
    assert not rejected['ok'] and 'missing or empty' in rejected['error'], rejected
    assert not command('test -e ' + shlex.quote(config_file) + ' && echo recreated', False)
    put(config_file, '')
    assert call('core-status').get('base') is None and not call('core-base')['ok']
    assert command('cat ' + shlex.quote(config_file)) == b''
    command('rm ' + shlex.quote(config_file) + ' && rmdir ' + shlex.quote(config_dir))
    assert call('core-status').get('base') is None and not call('core-base')['ok']
    assert not command('test -e ' + shlex.quote(config_dir) + ' && echo recreated', False)
    assert executions() == n, 'missing/empty configuration must never execute the core or trust stale cache'
    command('mkdir ' + shlex.quote(config_dir))
    put(config_file, b'x' * (1024 * 1024 + 1))
    assert call('core-status').get('base') is None and not call('core-base')['ok']
    assert executions() == n, 'unbounded configuration must not bypass snapshot isolation'
    config()
    assert call('core-base')['ok'] and call('core-status')['base']
    print('PASS: deleted/empty configuration and removed directories hide stale cache without recreating files; oversized files fail safely', flush=True)

    command('rm -f ' + started + ' ' + base_cache)
    captured = work + '/captured'
    base_program('value="$(cat "$3/lucky_base.lkcf")"\ntouch ' + captured + '\nsleep 2\nprintf "%s\\n" "$value"')
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(call, 'core-base')
        for _ in range(100):
            if command('test -e ' + captured + ' && echo yes', False): break
            time.sleep(.05)
        else: raise AssertionError('base query never read the file')
        config(port=16605)
        assert pending.result()['BaseConfigure']['AdminWebListenPort'] == 16601
    assert call('core-status').get('base') is None, 'changing config during a query must not poison the cache'
    assert call('core-base')['BaseConfigure']['AdminWebListenPort'] == 16605
    command('rm -f ' + started + ' ' + base_cache); n = executions()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(call, 'core-base'); wait_started()
        begin = time.monotonic()
        assert call('core-status').get('base') is None
        assert time.monotonic() - begin < 1.5
        second = pool.submit(call, 'core-base')
        assert first.result()['ok'] and second.result()['ok']
    assert executions() == n + 1
    command('chmod 600 ' + binary)
    assert call('core-status').get('base') is None and not call('core-base')['ok']
    print('PASS: concurrent config changes never poison cache; concurrent readers share one execution', flush=True)

    base_program()
    put(cache, 'version-cache-sentinel')
    assert call('core-base')['ok']
    assert call('base-invalidate')['ok']
    assert not command('test -e ' + base_cache + ' && echo exists', False)
    assert command('cat ' + cache) == b'version-cache-sentinel'
    assert call('base-invalidate')['ok'], 'invalidating an absent cache is idempotent'
    assert call('core-base')['ok']
    assert call('base-invalidate', invalidate_race=True)['ok'], 'another request may remove the cache first'
    command('mkdir ' + base_cache)
    blocked = call('base-invalidate')
    assert not blocked['ok'] and 'Cannot invalidate' in blocked['error'], blocked
    command('rmdir ' + base_cache)
    assert command('cat ' + cache) == b'version-cache-sentinel'
    print('PASS: repeated/concurrent invalidation succeeds; real unlink errors remain visible and preserve the version cache', flush=True)
    for operation in (['set-port', '16608'], ['set-safe-url', "/entry'quoted"],
                      ['set-internet', 'false'], ['reset-auth']):
        assert call('core-base')['ok']
        put(setter, '#!/bin/sh\n'
            'test ! -e ' + base_cache + ' || exit 99\n'
            'echo transient > ' + base_cache + '\n'
            'echo diagnostic >&2\nprintf "saved"\n', 0o700)
        result = call(operation, config_setter=True)
        assert result['ok'] and result['stdout'] == 'saved', result
        assert not command('test -e ' + base_cache + ' && echo exists', False)
        assert command('cat ' + cache) == b'version-cache-sentinel'
    assert call('core-base')['ok']
    put(setter, '#!/bin/sh\necho partial > ' + base_cache + '\necho write-failed >&2\nexit 7\n', 0o700)
    failed = call(['set-port', '16609'], config_setter=True)
    assert not failed['ok'] and 'write-failed' in failed['error']
    assert not command('test -e ' + base_cache + ' && echo exists', False)
    for name in ('config-output', 'config-error'):
        assert not command('test -e /tmp/lucky-luci-backup/' + name + ' && echo exists', False)
    print('PASS: setters invalidate before/after writes and partial failures; stderr stays separate; version cache survives', flush=True)

    command('rm -f ' + started)
    base_program('sleep 2\ncat "$3/lucky_base.lkcf"')
    config(port=16610, path=seed)
    put(setter, '#!/bin/sh\ncp ' + seed + ' ' + shlex.quote(config_file) + '\n', 0o700)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        querying = pool.submit(call, 'core-base'); wait_started()
        updating = pool.submit(call, ['set-port', '16610'], config_setter=True)
        assert querying.result()['ok'] and updating.result()['ok']
    assert call('core-status').get('base') is None
    assert call('core-base')['BaseConfigure']['AdminWebListenPort'] == 16610
    print('PASS: a concurrent query cannot republish stale cache after a completed setting change', flush=True)

    program(body='case "$1" in\n-info) echo \'{"Version":"3.2.3","Date":"test"}\';;\n'
                 '-baseConfInfo) cat "$3/lucky_base.lkcf";;\n*) exit 2;;\nesac')
    assert call()['ok'] and call('core-base')['ok']
    assert call('core-status')['info'] and call('core-status')['base']
    n = executions()
    command('chmod 600 ' + binary)
    blocked = call('core-status')
    assert blocked['status'] == 'permissions' and blocked.get('info') is None and blocked.get('base') is None
    assert not call()['ok'] and not call('core-base')['ok'] and executions() == n
    command('rm ' + binary)
    missing = call('core-status')
    assert missing['status'] == 'missing' and missing.get('info') is None and missing.get('base') is None
    assert not call()['ok'] and not call('core-base')['ok'] and executions() == n
    print('PASS: removing the core or execute permissions hides both populated caches without executing anything', flush=True)
finally:
    for target, content in originals.items():
        put(target, content, 0o755 if '/libexec/' in target else 0o644)
    # The only recursive removal is the mktemp directory created by this test.
    assert work.startswith('/tmp/lucky-info-test.') and '/' not in work[len('/tmp/'):]
    command('rm -rf ' + shlex.quote(work))
    assert command('sha256sum /usr/bin/lucky /etc/config/lucky') == before
    assert command('pidof lucky', False) == pid_before
    client.close()
