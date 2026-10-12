-- Run on an OpenWrt test VM: lua /tmp/test-lucky-diagnostics.lua
local d = require "luci.lucky_diagnostics"
local function log(tag, text) return "Mon Oct 12 10:00:00 2026 daemon.err " .. tag .. ": " .. text end
local function check(lines, source, kinds)
 local events = d.parse(lines, source)
 assert(#events == #kinds, "wrong number of excerpts: " .. #events .. " expected " .. #kinds)
 for i, kind in ipairs(kinds) do assert(events[i].kind == kind, events[i].kind .. " ~= " .. kind) end
 return events
end
local killed = "[  201.000000] Out of memory: Killed process 123 (lucky) total-vm:200000kB"
check({log("kernel", killed)}, "logread", {"oom"})
check({killed, "[202.0] Memory cgroup out of memory: Killed process 456 (lucky)"}, "dmesg", {"oom", "oom"})
check({"[ 300.0] oom-kill:constraint=CONSTRAINT_NONE,task=lucky,pid=123,uid=0"}, "dmesg", {"oom"})
check({"[ 300.0] lucky invoked oom-killer: gfp_mask=0x0", "[301.0] Killed process 456 (dnsmasq)"}, "dmesg", {})
check({"[301.0] Killed process 456 (unlucky)", "[302.0] lucky[123]: segfault at 0 ip 0x1"}, "dmesg", {"crash"})
check({"[301.0] lucky[123]: unhandled signal 11 at 0x100"}, "dmesg", {"crash"})
check({log("procd", "Instance lucky::config is in a crash loop 6 crashes, 0 seconds since last crash")}, "logread", {"restart_loop"})
check({log("procd", "Instance lucky::config exit with error code 256 after 1 seconds")}, "logread", {"exit"})
check({log("procd", "Instance lucky::config pid 123 exited with exit code 9 after 1 seconds")}, "logread", {"exit"})
check({log("procd", "Instance lucky::config stopped"), log("procd", "Instance lucky::config pid 123 exited with exit code 0 after 1 seconds"),
 log("lucky[123]", "Service stopped for backup"), log("procd", "Instance lucky::config exit with error code 15 after 1 seconds"),
 log("procd", "Instance notlucky::config is in a crash loop")}, "logread", {})
local events = check({log("lucky[123]", "panic: test failure"), log("lucky[123]", "goroutine 1 [running]:"),
 log("lucky[123]", "main.main()"), log("dnsmasq[456]", "private other service log"), log("lucky[456]", "unrelated request")}, "logread", {"crash"})
assert(events[1].text:find("main.main()", 1, true) and not events[1].text:find("private", 1, true))
check({log("lucky[123]", "fatal error: runtime: out of memory"), log("lucky[123]", "SIGSEGV: segmentation violation")}, "logread", {"crash", "crash"})
check({log("httpd[123]", "request body: lucky[456]: panic: fake"), log("unlucky[123]", "panic: fake"), log("lucky[123]", "URL: /panic: hello")}, "logread", {})
local many = {}
for i = 1, 100 do many[#many + 1] = log("lucky[123]", "panic: " .. i .. string.rep("x", 5000)) end
events = d.parse(many, "logread")
assert(#events == 6 and #events[6].text <= 900 and events[1].text:find("panic: 95", 1, true))
local collected = d.collect(function(source) return {source == "logread" and log("kernel", killed) or killed}, "ok" end)
assert(#collected.events == 1, "duplicate kernel record across logread/dmesg")
collected = d.collect(function(source) return {}, source == "logread" and "failed" or "unavailable" end)
assert(#collected.events == 0 and collected.sources[1].status == "failed")
if arg[1] == "--parse-only" then
 print("PASS: OOM, crash, procd, false positives, context bounds and deduplication")
 return
end
local lines, status = d.read({"/bin/sh", "-c", "echo denied; exit 1"})
assert(status == "failed")
lines, status = d.read({"/bin/sh", "-c", "i=0; while [ $i -lt 900 ]; do echo $i; i=$((i+1)); done"})
assert(status == "ok" and #lines == 600 and lines[1] == "300" and lines[600] == "899", "retain newest bounded lines")
lines, status = d.read({"/bin/sh", "-c", "printf '%s' partial"})
assert(status == "ok" and lines[1] == "partial")
lines, status = d.read({"/bin/sh", "-c", "while :; do :; done"})
assert(status == "timeout", "hung reader must time out")
local live = d.collect()
assert(#live.sources == 2 and live.sources[1].status == "ok" and live.sources[2].status == "ok", "real log tools must work")
local json = require "luci.jsonc"
assert(#json.stringify(live) < 24576, "RPC output must stay bounded")
print("PASS: OOM victim matching, crash context, false positives, restart records, deduplication, bounds, timeout and real log tools")
