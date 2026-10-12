"""Destructive watchdog tests in a disposable localhost OpenWrt VM (paramiko).

Install the newly built lucky and luci-app-lucky packages first. This exercises
real cron/procd and temporarily changes the VM's UCI configuration and crontab.
Never point this test at a production router via a forwarded port.
"""
import argparse
import json
import shlex
import time

import paramiko

parser = argparse.ArgumentParser()
parser.add_argument('--vm-port', type=int, required=True)
args = parser.parse_args()
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect('127.0.0.1', port=args.vm_port, username='root', password='',
                   look_for_keys=False, allow_agent=False, timeout=10)
except paramiko.AuthenticationException:
    client.get_transport().auth_none('root')


def command(text, check=True):
    i, o, e = client.exec_command(text, timeout=20)
    out, err = o.read(), e.read()
    code = o.channel.recv_exit_status()
    i.close(); o.close(); e.close()
    if check and code:
        raise AssertionError((text, code, out, err))
    return out


def put(path, data):
    i, o, e = client.exec_command('cat > ' + shlex.quote(path))
    i.write(data); i.flush(); i.channel.shutdown_write()
    assert o.channel.recv_exit_status() == 0
    i.close(); o.close(); e.close()


INIT = '/etc/init.d/lucky '
HELPER = '/usr/libexec/lucky-watchdog '


def status():
    return json.loads(command(HELPER + 'status'))


def pids():
    # An init-script invocation can briefly share the executable's process name.
    return command('for p in $(pidof lucky); do case "$(readlink /proc/$p/exe)" in '
                   '/usr/bin/lucky|"/usr/bin/lucky (deleted)") echo "$p";; esac; done').split()


def wait_running(seconds=15):
    for _ in range(seconds):
        if pids(): return
        time.sleep(1)
    raise AssertionError('Lucky did not recover')


def assert_stopped():
    command(HELPER + 'check')
    assert not pids(), 'Watchdog restarted a deliberately stopped service'
    assert status()['paused'], status()


original = command('cat /etc/config/lucky')
original_cron = command('cat /etc/crontabs/root', False)
had_cron = command('test -f /etc/crontabs/root && echo yes', False).strip() == b'yes'
was_running = bool(pids())
try:
    command(HELPER + 'disable')
    unrelated = b'# User Lucky task: keep this comment\n7 3 * * * : # unrelated-lucky-job\n'
    put('/tmp/lucky-watchdog-test.cron', original_cron + b'\n' + unrelated)
    command('crontab -u root /tmp/lucky-watchdog-test.cron')
    command(INIT + 'stop')
    command(HELPER + 'enable'); command(HELPER + 'enable')
    table = command('cat /etc/crontabs/root')
    assert table.count(b'# lucky-watchdog\n') == 1, table
    assert unrelated in table
    assert status() == dict(enabled=True, scheduled=True, paused=True, cron_running=True)
    assert_stopped()
    print('PASS: enabling is idempotent, keeps unrelated jobs, and does not resume a manual stop', flush=True)

    # Wait across a complete cron tick, continuously asserting the stopped state.
    for _ in range(65):
        assert not pids(), 'Actual cron restarted a manually stopped service'
        time.sleep(1)
    assert_stopped()
    print('PASS: actual cron leaves a manual stop untouched for 65 seconds', flush=True)

    command('/usr/libexec/lucky-call service start'); wait_running()
    assert not status()['paused']
    before = pids()
    for _ in range(3): command(HELPER + 'check')
    assert pids() == before, 'Watchdog replaced or duplicated the running instance'
    # Remove the supervisor's service state without invoking the deliberate-stop hook.
    command("ubus call service delete '{\"name\":\"lucky\"}'")
    for _ in range(10):
        if not pids(): break
        time.sleep(1)
    assert not pids()
    wait_running(70)
    assert len(pids()) == 1
    assert b'Watchdog recovering unexpectedly stopped' in command('logread')
    print('PASS: actual cron recovers a lost procd service with exactly one process', flush=True)

    command("ubus call service delete '{\"name\":\"lucky\"}'")
    time.sleep(2)
    command(HELPER + 'check')
    assert not pids(), 'Repeated recovery ignored the five-minute cooldown'
    command(INIT + 'start'); wait_running()
    print('PASS: repeated failure is rate-limited; explicit start overrides the cooldown', flush=True)

    for _ in range(8):
        command(HELPER + 'check & ' + INIT + 'stop & wait')
        assert_stopped()
        command(INIT + 'start'); wait_running()
    command('/usr/libexec/lucky-call service stop')
    command(HELPER + 'disable'); command(HELPER + 'enable')
    assert command('uci -q get lucky.@lucky[0].enabled').strip() == b'0'
    assert_stopped()
    print('PASS: concurrent stop/check and LuCI stop cannot be undone by recovery or toggling', flush=True)

    # Real clear operation must keep the configuration empty, even with recovery enabled.
    command('/usr/libexec/lucky-call service start'); wait_running()
    config = command('mktemp -d /tmp/lucky-watchdog-config.XXXXXX').decode().strip()
    command('uci set lucky.@lucky[0].configdir=' + shlex.quote(config) + '; uci commit lucky')
    command(INIT + 'restart'); wait_running()
    for _ in range(15):
        if command('find ' + shlex.quote(config) + ' -name "*.lkcf"').strip(): break
        time.sleep(1)
    def archive(op, token=''):
        value = json.loads(command('/usr/libexec/lucky-backup ' + op + ' ' + token))
        assert value['ok'], value
        return value
    token = archive('prepare')['token']
    archive('clear-check', token); archive('clear', token)
    assert_stopped()
    assert not command('ls -A ' + shlex.quote(config)).strip()
    archive('cleanup', token)
    command('rmdir ' + shlex.quote(config))
    print('PASS: real configuration clear stays stopped and empty with recovery enabled', flush=True)

    command(HELPER + 'disable')
    table = command('cat /etc/crontabs/root')
    assert b'# lucky-watchdog\n' not in table and unrelated in table
    assert not status()['enabled'] and not status()['scheduled']
    print('PASS: disabling removes only the plugin-owned cron entry', flush=True)
finally:
    command(INIT + 'stop', False)
    put('/etc/config/lucky', original)
    put('/tmp/lucky-watchdog-test.cron', original_cron)
    command('crontab -u root /tmp/lucky-watchdog-test.cron')
    if not had_cron: command('crontab -u root -r', False)
    command('rm -f /tmp/lucky-watchdog-test.cron')
    if was_running: command(INIT + 'start')
    client.close()
