"""Deploy and test diagnostics on a disposable localhost OpenWrt VM."""
import argparse
import json
from pathlib import Path
import shlex
import time

import paramiko

p = argparse.ArgumentParser()
p.add_argument('--vm-port', type=int, required=True)
args = p.parse_args()
root = Path(__file__).resolve().parent.parent
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect('127.0.0.1', port=args.vm_port, username='root', password='',
                   allow_agent=False, look_for_keys=False, timeout=10)
except paramiko.AuthenticationException:
    client.get_transport().auth_none('root')


def run(command):
    i, o, e = client.exec_command(command, timeout=20)
    out, err = o.read(), e.read()
    code = o.channel.recv_exit_status()
    i.close(); o.close(); e.close()
    assert code == 0, (command, out, err)
    return out


def put(source, destination):
    i, o, e = client.exec_command('cat > ' + shlex.quote(destination))
    i.write(source.read_bytes()); i.flush(); i.channel.shutdown_write()
    assert o.channel.recv_exit_status() == 0
    i.close(); o.close(); e.close()


try:
    board = json.loads(run('ubus call system board'))
    assert board['release']['distribution'] == 'OpenWrt', 'Disposable OpenWrt VM required'
    run('mkdir -p /usr/lib/lua/luci')
    put(root / 'luci-app-lucky/root/usr/lib/lua/luci/lucky_diagnostics.lua', '/usr/lib/lua/luci/lucky_diagnostics.lua')
    put(root / 'luci-app-lucky/root/usr/libexec/lucky-diagnostics', '/usr/libexec/lucky-diagnostics')
    put(root / 'scripts/test-lucky-diagnostics.lua', '/tmp/test-lucky-diagnostics.lua')
    run('chmod 755 /usr/libexec/lucky-diagnostics')
    print(board['release']['version'], run('lua /tmp/test-lucky-diagnostics.lua').decode().strip(), flush=True)
    before = run('pidof lucky || true')
    start = time.monotonic()
    result = json.loads(run('/usr/libexec/lucky-diagnostics read'))
    elapsed = time.monotonic() - start
    assert elapsed < 8, elapsed
    assert before == run('pidof lucky || true'), 'Diagnostics must not restart the core'
    assert len(result['sources']) == 2
    assert all(x['status'] == 'ok' for x in result['sources']), result['sources']
    # Clearly marked synthetic crash evidence through the real system log path.
    run("logger -t lucky -p daemon.err 'panic: [LuCI diagnostic test fixture] simulated failure'")
    time.sleep(.2)
    result = json.loads(run('/usr/libexec/lucky-diagnostics read'))
    assert any(x['kind'] == 'crash' and '[LuCI diagnostic test fixture]' in x['text'] for x in result['events']), result
    print('PASS: real logread/dmesg, JSON command, injected fixture, unchanged Lucky PID; read %.2fs' % elapsed, flush=True)
finally:
    client.close()
