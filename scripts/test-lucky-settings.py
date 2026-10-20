"""Exercise access-setting transactions with a real core in a disposable OpenWrt VM.

The current LuCI files and lucky service/helper must already be installed.
Only connects to localhost. Temporarily selects a private configuration directory,
restores the original service state, and never prints passwords or control tokens.
"""
import argparse
import http.client
import json
import logging
import re
import shlex
import time
import urllib.parse

import paramiko

logging.getLogger("paramiko.transport").setLevel(logging.CRITICAL)

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--vm-port", type=int, required=True)
parser.add_argument("--require-policy", action="store_true",
                    help="require the updated core's AllowInternetaccess query field")
parser.add_argument("--require-local-control", action="store_true",
                    help="require v3.4.0+ local commands without restarting the service")
args = parser.parse_args()
online = False
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
try:
    client.connect("127.0.0.1", port=args.vm_port, username="root", password="",
                   allow_agent=False, look_for_keys=False)
except paramiko.AuthenticationException:
    client.get_transport().auth_none("root")


def command(value, check=True):
    stdin, stdout, stderr = client.exec_command(value, timeout=90)
    data, error = stdout.read(), stderr.read()
    code = stdout.channel.recv_exit_status()
    stdin.close(); stdout.close(); stderr.close()
    if check:
        assert code == 0, (value, code, error.decode(errors="replace"))
    return data


def put(path, data, mode=0o600):
    stdin, stdout, stderr = client.exec_command(
        "cat > " + shlex.quote(path) + " && chmod " + oct(mode)[2:] + " " + shlex.quote(path))
    stdin.write(data); stdin.flush(); stdin.channel.shutdown_write()
    code, error = stdout.channel.recv_exit_status(), stderr.read()
    stdin.close(); stdout.close(); stderr.close()
    assert code == 0, (path, error)


def call(*params, ok=True):
    before = pid() if online and params[0] in ("set-safe-url", "set-port", "set-internet") else None
    if params[0] in ("set-safe-url", "set-port", "set-internet", "reset-auth"):
        params = ("configure", urllib.parse.quote(json.dumps(params, ensure_ascii=False), safe=""))
    response = json.loads(command("/usr/libexec/lucky-backup " + " ".join(map(shlex.quote, params))))
    assert response["ok"] == ok, response
    if before:
        assert pid() == before, "local configuration must preserve the main process"
    return response


def base():
    return call("core-base")["BaseConfigure"]


def pid():
    return command("pidof lucky", False).strip()


def wait_running():
    for _ in range(50):
        if pid():
            return
        time.sleep(0.1)
    raise AssertionError("core did not start")


def http_get(path, port=16601):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.sock = client.get_transport().open_channel(
        "direct-tcpip", ("127.0.0.1", port), ("127.0.0.1", 0), timeout=5)
    try:
        conn.request("GET", urllib.parse.quote(path, safe="/"))
        response = conn.getresponse()
        body = response.read()
        return response.status, body
    finally:
        conn.close()


def wait_entry(path, port=16601):
    for _ in range(60):
        try:
            status, body = http_get(path, port)
            if status in (200, 301, 302, 307, 308):
                return
        except (OSError, paramiko.SSHException, http.client.HTTPException):
            pass
        time.sleep(0.1)
    raise AssertionError(("entry unavailable", path, port))


original_uci = command("cat /etc/config/lucky")
original_init = command("cat /etc/init.d/lucky")
original_helper = command("cat /usr/libexec/lucky-call")
was_running = bool(pid())
work = command("mktemp -d /tmp/lucky-settings-test.XXXXXX").decode().strip()
binary_moved = False
mounted = []
try:
    command("/etc/init.d/lucky stop")
    command("uci set lucky.@lucky[0].configdir=" + shlex.quote(work + "/config") +
            "; uci set lucky.@lucky[0].enabled=1; uci commit lucky; /etc/init.d/lucky start")
    wait_running()
    wait_entry("/")
    info = json.loads(command("/usr/bin/lucky -info"))
    version = info["Version"]
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version)
    online = bool(match and tuple(map(int, match.groups())) >= (3, 4, 0))
    if args.require_local_control:
        assert online, "requires a v3.4.0+ core"
    if online:
        # HTTP becomes available before the local control socket.
        for _ in range(40):
            ready = command("/usr/bin/lucky -rSetHttpAdminPort 16601 -cd " +
                            shlex.quote(work + "/config") + " >/dev/null 2>&1 && echo ready", False)
            if ready.strip() == b"ready":
                break
            time.sleep(0.2)
        assert ready.strip() == b"ready", "local control server did not become ready"
    print("Testing real Lucky", version, "on", command(". /etc/openwrt_release; echo $DISTRIB_RELEASE").decode().strip(), flush=True)
    marker = work + "/config/ip-allowlist.txt"
    put(marker, b"# preserve this file\n")
    call("core-info")
    info_cache = command("cat /tmp/lucky_core_info")
    base()
    previous_pid = pid()
    assert not call("set-safe-url", "/settings-entry").get("warning")
    assert pid() and ((pid() == previous_pid) if online else (pid() != previous_pid))
    assert not command("test -e /tmp/lucky_base_info && echo exists", False)
    assert command("cat /tmp/lucky_core_info") == info_cache
    assert base()["SafeURL"] == "/settings-entry"
    wait_entry("/settings-entry/")
    assert http_get("/")[0] == 404
    # A later save by the running main process used to restore the OLD entry.
    if version.startswith("3."):
        # The HTTP listener comes up before the core's delayed control server.
        for _ in range(30):
            ready = command("/usr/bin/lucky -rSetHttpAdminPort 16601 -cd " +
                            shlex.quote(work + "/config") + " >/dev/null 2>&1 && echo ready", False)
            if ready.strip() == b"ready":
                break
            time.sleep(0.2)
        assert ready.strip() == b"ready", "control server did not become ready"
        assert base()["SafeURL"] == "/settings-entry"
        wait_entry("/settings-entry/")
        print("PASS: a later main-process save preserves the updated entry", flush=True)
    print("PASS: saved entry is live, old entry rejected, caches correct", flush=True)

    for value in ("/nested/entry", "/entry'quoted", ""):
        assert not call("set-safe-url", value).get("warning")
        expected = "/" + value[1:].replace("/", "") if version.startswith("2.") and value else value
        assert base()["SafeURL"] == expected, (value, base()["SafeURL"])
        wait_entry(expected + "/")
    assert not call("set-port", "16602").get("warning")
    assert base()["AdminWebListenPort"] == 16602
    wait_entry("/", 16602)
    call("set-port", "16601")
    for value in ("true", "false"):
        assert not call("set-internet", value).get("warning")
        policy = base().get("AllowInternetaccess")
        if args.require_policy:
            assert isinstance(policy, bool), "updated core must report the access policy"
        if policy is not None:
            assert policy == (value == "true")
    assert command("cat " + shlex.quote(marker)) == b"# preserve this file\n"
    print("PASS: nested/quoted/empty entry, HTTP port and Internet policy; other configuration preserved", flush=True)

    # These are valid existing config locations; only destructive directory
    # replacement should reject them. Settings update files in place.
    command("ln -s " + shlex.quote(work + "/config") + " " + shlex.quote(work + "/linked"))
    command("mkdir " + shlex.quote(work + "/mounted"))
    command("mount -o bind " + shlex.quote(work + "/config") + " " + shlex.quote(work + "/mounted"))
    mounted.append(work + "/mounted")
    for directory in ("linked", "mounted"):
        command("uci set lucky.@lucky[0].configdir=" + shlex.quote(work + "/" + directory) + "; uci commit lucky")
        assert not call("set-safe-url", "/" + directory).get("warning")
        assert base()["SafeURL"] == "/" + directory
        wait_entry("/" + directory + "/")
    command("uci set lucky.@lucky[0].configdir=" + shlex.quote(work + "/config") + "; uci commit lucky")
    command("mkdir " + shlex.quote(work + "/config/nested"))
    command("mount -t tmpfs tmpfs " + shlex.quote(work + "/config/nested"))
    mounted.append(work + "/config/nested")
    assert not call("set-safe-url", "").get("warning")
    wait_entry("/")
    assert command("cat " + shlex.quote(marker)) == b"# preserve this file\n"
    print("PASS: settings support symlinked, mounted and nested-mount config directories", flush=True)

    before_pid = pid()
    for operation in (("set-port", "0"), ("set-safe-url", "relative"), ("set-internet", "yes")):
        call(*operation, ok=False)
        assert pid() == before_pid, "invalid arguments must not interrupt Lucky"
    for payload in ("", "%", "%7B%7D", urllib.parse.quote('["set-port","16601","extra"]'), "x" * 4097):
        call("configure", payload, ok=False)
        assert pid() == before_pid, "invalid envelopes must not interrupt Lucky"
    if online:
        # No new-core setter may call the offline helper, even after failure.
        put("/usr/libexec/lucky-call", b"#!/bin/sh\necho offline-helper-called >&2\nexit 7\n", 0o755)
        try:
            call("set-safe-url", "/local-command")
            call("set-safe-url", "")
            failure = call("set-port", "80", ok=False)  # uhttpd owns port 80
            assert not failure.get("warning") and "offline-helper-called" not in failure["error"]
            assert base()["AdminWebListenPort"] == 16601
        finally:
            put("/usr/libexec/lucky-call", original_helper, 0o755)
        other = work + "/other"
        command("mkdir " + shlex.quote(other) + "; uci set lucky.@lucky[0].configdir=" +
                shlex.quote(other) + "; uci commit lucky")
        try:
            call("set-safe-url", "/wrong-instance", ok=False)
            assert not command("ls -A " + shlex.quote(other))
        finally:
            command("uci set lucky.@lucky[0].configdir=" + shlex.quote(work + "/config") + "; uci commit lucky")
        runtime_dirs = ("/run/lucky-control-0", "/var/run/lucky-control-0", "/tmp/lucky-control-0",
                        "/run/lucky", "/var/run/lucky")
        socket = command("find " + " ".join(runtime_dirs) + " -name control.sock 2>/dev/null | head -n 1").decode().strip()
        assert socket.startswith(tuple(path + "/" for path in runtime_dirs))
        command("mv " + shlex.quote(socket) + " " + shlex.quote(socket + ".test-disabled"))
        try:
            call("set-safe-url", "/unavailable-ipc", ok=False)
            assert base()["SafeURL"] == ""
            wait_entry("/")
        finally:
            command("mv " + shlex.quote(socket + ".test-disabled") + " " + shlex.quote(socket))
        # Explicit false and empty CLI values must not be mistaken for omission.
        before = pid()
        prefix = "/usr/bin/lucky -cd " + shlex.quote(work + "/config")
        for params in (["-rSetSafeURL", "/direct"], ["-rSetAllowInternetaccess", "true"],
                       ["-rSetAllowInternetaccess", "false"], ["-rSetSafeURL", ""],
                       ["-rSetSafeURL", "/cancel"], ["-rCancelSafeURL"]):
            command(prefix + " " + " ".join(map(shlex.quote, params)))
            assert pid() == before
        call("base-invalidate")
        assert base()["SafeURL"] == "" and base()["AllowInternetaccess"] is False
        wait_entry("/")
        # Existing local commands also work without an explicit -cd.
        command("/usr/bin/lucky -rSetSafeURL /default-instance")
        command("/usr/bin/lucky -rCancelSafeURL")
        assert pid() == before
        wait_entry("/")
        print("PASS: local setters preserve PID; occupied port, wrong instance and missing socket fail without offline fallback", flush=True)
    else:
        # A failed writer must recover the original working service.
        put("/usr/libexec/lucky-call", b"#!/bin/sh\necho fixture-write-failed >&2\nexit 7\n", 0o755)
        try:
            failure = call("set-safe-url", "/must-not-be-saved", ok=False)
            assert "fixture-write-failed" in failure["error"] and not failure.get("warning")
            wait_entry("/")
            assert base()["SafeURL"] == ""
        finally:
            put("/usr/libexec/lucky-call", original_helper, 0o755)
        print("PASS: invalid input does not stop service; failed writes resume the original working configuration", flush=True)

    # A successful save followed by a failed start must be reported separately.
    broken_init = original_init.replace(b"start_service() {", b"start_service() {\n\treturn 1")
    assert broken_init != original_init, "requires the current procd init script"
    put("/etc/init.d/lucky", broken_init, 0o755)
    try:
        if not online:
            response = call("set-safe-url", "/saved-but-stopped")
            assert response.get("warning") and not pid()
            assert base()["SafeURL"] == "/saved-but-stopped"
            put("/etc/init.d/lucky", original_init, 0o755)
            command("/etc/init.d/lucky start")
            wait_running()
            put("/etc/init.d/lucky", broken_init, 0o755)
        reset_response = call("reset-auth")
        credentials = json.loads(reset_response["stdout"])
        assert credentials["account"] == "admin" and len(credentials["password"]) == 24
        # Older helpers report command success even if procd cannot run the
        # process. The outer warning must survive alongside the new password.
        assert reset_response.get("warning") and not pid()
    finally:
        put("/etc/init.d/lucky", original_init, 0o755)
    print("PASS: failed restart reports saved configuration and stopped service", flush=True)

    command("uci set lucky.@lucky[0].enabled=0; uci commit lucky; /etc/init.d/lucky stop")
    for operation in (("set-safe-url", "/stopped-entry"), ("set-port", "16601"), ("set-internet", "false")):
        assert not call(*operation).get("warning")
        assert not pid(), "saving must not start a manually stopped service"
        assert command("uci -q get lucky.@lucky[0].enabled").strip() == b"0"
    command("/etc/init.d/lucky watchdog")
    assert not pid()
    command("mv /usr/bin/lucky " + shlex.quote(work + "/core"))
    binary_moved = True
    before = command("sha256sum " + shlex.quote(work + "/config/lucky_base.lkcf"))
    call("set-safe-url", "/missing-core", ok=False)
    assert command("sha256sum " + shlex.quote(work + "/config/lucky_base.lkcf")) == before
    command("mv " + shlex.quote(work + "/core") + " /usr/bin/lucky")
    binary_moved = False
    command("chmod 600 /usr/bin/lucky")
    try:
        call("set-safe-url", "/not-executable", ok=False)
        assert command("sha256sum " + shlex.quote(work + "/config/lucky_base.lkcf")) == before
    finally:
        command("chmod 755 /usr/bin/lucky")
    command("uci set lucky.@lucky[0].configdir=" + shlex.quote(work + "/absent") + "; uci commit lucky")
    call("set-safe-url", "/missing-directory", ok=False)
    assert not command("test -e " + shlex.quote(work + "/absent") + " && echo exists", False)
    print("PASS: stopped service stays stopped; missing/non-executable core and deleted directory fail without writes", flush=True)
finally:
    put("/etc/init.d/lucky", original_init, 0o755)
    put("/usr/libexec/lucky-call", original_helper, 0o755)
    command("/etc/init.d/lucky stop", False)
    for mount in reversed(mounted):
        command("umount " + shlex.quote(mount))
    if binary_moved:
        command("mv " + shlex.quote(work + "/core") + " /usr/bin/lucky")
    put("/etc/config/lucky", original_uci)
    command("rm -f /tmp/lucky_base_info")
    if was_running:
        command("/etc/init.d/lucky start")
    assert work.startswith("/tmp/lucky-settings-test.")
    command("rm -rf " + shlex.quote(work))
    client.close()
