"""Integration test against a disposable OpenWrt VM on localhost (requires paramiko).
Run: python3 scripts/test-lucky-backup.py --vm-port 21922
Temporarily switches the VM's Lucky config directory, then restores its UCI config.
Never use a production router for these destructive restore tests.
"""
import argparse
import io
import json
import os
from pathlib import Path
import shlex
import stat
import time
import uuid
import zipfile
import paramiko

parser = argparse.ArgumentParser()
parser.add_argument('--vm-port', type=int, required=True)
args = parser.parse_args()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect('127.0.0.1', port=args.vm_port, username='root', password=os.environ.get('LUCKY_TEST_VM_PASSWORD', ''), look_for_keys=False, allow_agent=False, timeout=10)
except paramiko.AuthenticationException:
    client.get_transport().auth_none('root')

def command(cmd, check=True):
    i, o, e = client.exec_command(cmd)
    data, err = o.read(), e.read()
    code = o.channel.recv_exit_status()
    i.close(); o.close(); e.close()
    if check and code:
        raise AssertionError(f'Command failed ({code}): {cmd}\n{err.decode(errors="replace")}')
    return data

def put(path, data, executable=False):
    i, o, e = client.exec_command('cat > ' + shlex.quote(path))
    i.write(data); i.flush(); i.channel.shutdown_write()
    assert o.channel.recv_exit_status() == 0
    i.close(); o.close(); e.close()
    if executable: command('chmod 755 ' + shlex.quote(path))

def call(op, token=None, success=True):
    raw = command('/usr/libexec/lucky-backup ' + op + (' ' + token if token else ''))
    reply = json.loads(raw)
    assert reply['ok'] == success, reply
    assert not reply.get('warning'), reply
    return reply

root = Path(__file__).resolve().parent.parent
for local, remote in [
    ('luci-app-lucky/root/usr/libexec/lucky-backup', '/usr/libexec/lucky-backup'),
    ('luci-app-lucky/root/usr/lib/lua/luci/lucky_archive.lua', '/usr/lib/lua/luci/lucky_archive.lua'),
    ('luci-app-lucky/root/usr/lib/lua/luci/lucky_core.lua', '/usr/lib/lua/luci/lucky_core.lua'),
]:
    put(remote, (root / local).read_bytes().replace(b'\r\n', b'\n'), local.endswith('lucky-backup'))

original = command('cat /etc/config/lucky')
was_running = bool(command('pidof lucky', check=False).strip())
fixture = '/tmp/lucky-backup-test-' + uuid.uuid4().hex
conf = fixture + '/config'
tokens = []
def prepare():
    token = call('prepare')['token']; tokens.append(token); return token

def upload(token, data):
    put('/tmp/lucky-luci-backup/' + token + '/upload.zip', data)

def archive(entries, comment=b'LUCI-LUCKY-DIRECTORY-BACKUP:1'):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as z:
        z.comment = comment
        for name, content, mode in entries:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = mode << 16
            z.writestr(info, content)
    return output.getvalue()

try:
    command('/etc/init.d/lucky stop')
    command('mkdir -p ' + conf + '/nested/empty')
    command('/usr/bin/lucky -setconf -key AdminWebListenPort -value 19661 -cd ' + shlex.quote(conf))
    command("uci set lucky.@lucky[0].configdir=" + shlex.quote(conf) + "; uci set lucky.@lucky[0].enabled=1; uci commit lucky; /etc/init.d/lucky start")
    time.sleep(2)
    assert command('pidof lucky').strip()
    samples = {'ip-allowlist.txt': b'# test\n192.0.2.1\n', 'localips': b'10.0.0.0/8\n192.168.0.0/16\n', 'binary.bin': bytes(range(256)) * 400, '.hidden': b'hidden', 'nested/space name': b'file with spaces', 'nested/中文': '测试'.encode(), 'script.sh': b'#!/bin/sh\nexit 0\n'}
    for name, data in samples.items(): put(conf + '/' + name, data)
    command('chmod 750 ' + conf + '/script.sh')
    token = prepare()
    old_pid = command('pidof lucky').strip()
    call('backup', token)
    for _ in range(30):
        if command('pidof lucky', check=False).strip(): break
        time.sleep(.2)
    assert command('pidof lucky').strip() != old_pid, 'backup must stop and resume Lucky'
    data = command('cat /tmp/lucky-luci-backup/' + token + '/backup.zip')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        assert z.testzip() is None
        assert z.comment == b'LUCI-LUCKY-DIRECTORY-BACKUP:1'
        for name, content in samples.items(): assert z.read(name) == content
        assert 'nested/empty/' in z.namelist()
        assert (z.getinfo('script.sh').external_attr >> 16) & 0o777 == 0o750
        backed_up = {name: z.read(name) for name in z.namelist() if not name.endswith('/')}
    print('PASS: running service stopped/resumed; standard ZIP CRC, binary, hidden, Unicode, empty directories and modes')

    command('/etc/init.d/lucky stop')
    put(conf + '/binary.bin', b'mutated')
    put(conf + '/stale.bin', b'must disappear')
    restore = prepare(); upload(restore, data)
    call('check', restore)
    put('/tmp/lucky_base_info', b'cached-before-restore')
    call('restore', restore)
    assert not command('test -e /tmp/lucky_base_info && echo exists', check=False)
    assert not command('pidof lucky', check=False).strip(), 'stopped service must remain stopped'
    assert command('test ! -e ' + conf + '/stale.bin') == b''
    for name, content in backed_up.items(): assert command('cat ' + shlex.quote(conf + '/' + name)) == content, name
    assert command('lua -e ' + shlex.quote('print(require("nixio.fs").stat("' + conf + '/script.sh").modedec)')).strip() == b'750'
    print('PASS: full replacement removes stale files and restores every byte; stopped service stays stopped')

    command('/etc/init.d/lucky start'); time.sleep(1)
    pid = command('pidof lucky').strip()
    corrupt = bytearray(data)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        start = z.getinfo('binary.bin').header_offset + 30 + len('binary.bin')
    corrupt[start] ^= 1
    cases = {
        'corrupt CRC': bytes(corrupt),
        'truncated': data[:-1],
        'module ZIP': archive([('base.lkcf', b'not a directory backup', 0o100600)], b''),
        'traversal': archive([('../escape', b'bad', 0o100600)]),
        'absolute path': archive([('/tmp/escape', b'bad', 0o100600)]),
        'symlink': archive([('link', b'/etc/passwd', 0o120777)]),
        'duplicate': archive([('same', b'one', 0o100600), ('same', b'two', 0o100600)]),
        'file parent': archive([('dir', b'file', 0o100600), ('dir/file', b'child', 0o100600)]),
    }
    for name, broken in cases.items():
        trial = prepare(); upload(trial, broken)
        call('check', trial, success=False)
        call('restore', trial, success=False)
        assert command('pidof lucky').strip() == pid, name + ': failed validation stopped service'
        assert command('cat ' + conf + '/binary.bin') == samples['binary.bin']
    print('PASS: corrupt/truncated/foreign archives, traversal, absolute paths, symlinks, duplicates and path conflicts rejected before stop')

    # Restore from the same backup while running: no old files may survive.
    put(conf + '/stale.bin', b'old')
    preview = call('check', restore)
    assert 'stale.bin' in preview['removed'] and 'binary.bin' in preview['replaced']
    call('restore', restore)
    assert command('pidof lucky').strip() != pid
    command('test ! -e ' + conf + '/stale.bin')
    print('PASS: running service stopped/resumed during restore')

    # Inject failure between the two renames; restore must put the old tree back.
    put(conf + '/rollback-marker', b'preserve me')
    call('check', restore)
    wrapper = fixture + '/rename-failure.lua'
    put(wrapper, b'local fs = require "nixio.fs"; local rename = fs.rename; fs.rename = function(from, to) if from:find("/.lucky-restore-", 1, true) then return nil end return rename(from, to) end; dofile("/usr/libexec/lucky-backup")')
    reply = json.loads(command('lua ' + wrapper + ' restore ' + restore))
    assert not reply['ok'] and 'original files were restored' in reply['error'], reply
    assert not reply.get('warning'), reply
    assert command('cat ' + conf + '/rollback-marker') == b'preserve me'
    assert command('pidof lucky').strip()
    print('PASS: directory-swap failure rolls back original files and resumes service')

    # OS advisory locks are released automatically when their owner exits.
    i, o, e = client.exec_command('lua -e ' + shlex.quote('local n=require "nixio"; local f=assert(n.open("/tmp/lucky-luci-backup/lock", "w", "600")); assert(f:lock("tlock")); print("locked"); io.stdout:flush(); n.nanosleep(3)'))
    assert o.readline().strip() == 'locked'
    assert 'in progress' in call('prepare', success=False)['error']
    o.channel.recv_exit_status(); i.close(); o.close(); e.close()
    prepare()
    print('PASS: concurrent operations excluded and lock released after owner exits')

    command('ln -s /etc/passwd ' + conf + '/outside-link')
    trial = prepare(); call('backup', trial, success=False)
    assert command('pidof lucky').strip(), 'failed backup must resume original service'
    command('rm ' + conf + '/outside-link')
    print('PASS: source symlinks refused and service recovered after backup failure')

    call('check', restore)
    put(conf + '/not-in-preview', b'new file')
    pid = command('pidof lucky').strip()
    assert 'file list changed' in call('restore', restore, success=False)['error']
    assert command('cat ' + conf + '/not-in-preview') == b'new file'
    assert command('pidof lucky').strip() == pid
    print('PASS: new files appearing after preview force reconfirmation without stopping service')

    other = fixture + '/other-app'
    command('mkdir ' + other)
    put(other + '/application.db', b'never delete')
    command('uci set lucky.@lucky[0].configdir=' + shlex.quote(other) + '; uci commit lucky')
    trial = prepare(); upload(trial, data)
    assert '.lkcf' in call('check', trial, success=False)['error']
    command('ln -s ' + conf + '/binary.bin ' + other + '/fake.lkcf')
    assert '.lkcf' in call('check', trial, success=False)['error']
    assert command('cat ' + other + '/application.db') == b'never delete'
    assert command('pidof lucky').strip() == pid
    print('PASS: non-Lucky directory and fake LKCF symlink rejected without deleting unrelated files')

    command('/etc/init.d/lucky stop')
    command('rm ' + other + '/application.db ' + other + '/fake.lkcf')
    preview = call('check', trial)
    assert not preview['removed'] and not preview['replaced'] and preview['added']
    call('restore', trial)
    assert not command('pidof lucky', check=False).strip()
    for name, content in backed_up.items(): assert command('cat ' + shlex.quote(other + '/' + name)) == content
    print('PASS: empty dedicated directory accepted for complete restore')
    command('/etc/init.d/lucky start'); time.sleep(1)
    command("dd if=/dev/zero of=" + other + "/large.db bs=1 count=1 seek=67108865 2>/dev/null")
    clear = prepare()
    call('clear', clear, success=False)
    preview = call('clear-check', clear)
    assert '.hidden' in preview['removed'] and 'nested/empty/' in preview['removed']
    put(other + '/after-preview', b'keep')
    call('clear', clear, success=False)
    assert command('cat ' + other + '/after-preview') == b'keep'
    call('clear-check', clear)
    reply = json.loads(command('lua ' + wrapper + ' clear ' + clear))
    assert not reply['ok'] and command('cat ' + other + '/after-preview') == b'keep'
    assert command('pidof lucky').strip(), 'failed clear must resume service'
    call('clear-check', clear)
    put('/tmp/lucky_base_info', b'cached-before-clear')
    call('clear', clear)
    assert not command('test -e /tmp/lucky_base_info && echo exists', check=False)
    assert not command('pidof lucky', check=False).strip(), 'clear must leave service stopped'
    assert call('core-status').get('base') is None
    call('core-base', success=False)
    command('test -d ' + other)
    assert command('ls -A ' + other).strip() == b'', 'hidden files and subdirectories must disappear and refresh must not recreate them'
    call('clear-check', clear); call('clear', clear)
    put(other + '/unrelated.db', b'keep unrelated')
    call('clear-check', clear, success=False); call('clear', clear, success=False)
    assert command('cat ' + other + '/unrelated.db') == b'keep unrelated'
    print('PASS: clear preview required; changed list and wrong directory rejected; rollback recovers; complete clear leaves service stopped')
finally:
    command('/etc/init.d/lucky stop', check=False)
    put('/etc/config/lucky', original)
    if was_running: command('/etc/init.d/lucky start', check=False)
    for token in tokens: call('cleanup', token)
    command('rm -rf ' + shlex.quote(fixture))
    client.close()
