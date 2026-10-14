-- SPDX-License-Identifier: Apache-2.0
-- Run with Lua 5.1. Exercise the legacy HTTP boundary, including yielding
-- response writes, without a router, root access or real filesystem changes.
local env, request, chunks, status, output, files, calls, opens
local ctx = { authuser = "root", authtoken = "csrf", authsession = "session" }
local token = string.rep("a", 32)
local work = "/tmp/lucky-luci-backup/" .. token
local function expect(value, message) assert(value, message) end

package.preload["luci.dispatcher"] = function() return { context = ctx } end
package.preload["luci.jsonc"] = function() return {
	parse = function(value) return value == "BODY" and request or nil end,
	stringify = function(value) return value end
} end
package.preload["luci.http"] = function() return {
	header = function() end, prepare_content = function() end,
	getenv = function(name) return env[name] end,
	status = function(value) status = value end,
	write = function(value) coroutine.yield(value) end,
	content = function() return "BODY" end,
	source = function() return function() return table.remove(chunks, 1) end end
} end
package.preload["nixio.fs"] = function() return {
	lstat = function(path) return { type = "dir", uid = 0 } end,
	readfile = function(path) return files[path] end,
	statvfs = function() return { bavail = 100000, frsize = 4096 } end,
	rename = function(src, dest) files[dest] = files[src]; files[src] = nil; return true end,
	unlink = function(path) files[path] = nil end,
	access = function() return true end
} end
package.preload["nixio.util"] = function() return {} end
package.preload["nixio"] = function() return {
	open_flags = function() return 1 end,
	open = function(path)
		opens = opens + 1; files[path] = ""
		return { writeall = function(_, value) files[path] = files[path] .. value; return #value end,
			close = function() end }
	end,
	pipe = function()
		local read = false
		return { read = function() if not read then read = true; return "streamed-result" end end,
			close = function() end }, { close = function() end }
	end,
	fork = function() return 123 end,
	waitpid = function() return 123, "exited", 0 end
} end
package.preload["ubus"] = function() return { connect = function() return {
	call = function(_, object, method, args)
		expect(object == "file" and method == "exec", "only the expected ubus method")
		calls[#calls + 1] = args
		return { code = 0, stdout = "true\n" }
	end, close = function() end
} end } end

local bridge = dofile("luci-app-lucky/root/usr/lib/lua/luci/lucky_legacy.lua")
local function run(operation, data, body, overrides)
	status, output, calls, opens = 200, {}, {}, 0
	request = data or {}; chunks = body or {}
	files = { [work .. "/legacy-session"] = "session" }
	env = { REQUEST_METHOD = "POST", CONTENT_LENGTH = "100" }
	for key, value in pairs(overrides or {}) do env[key] = value end
	local thread = coroutine.create(function() bridge.dispatch(operation) end)
	while coroutine.status(thread) ~= "dead" do
		local ok, value = coroutine.resume(thread)
		expect(ok, "response must yield safely under Lua 5.1: " .. tostring(value))
		if value then output[#output + 1] = value end
	end
	return output[1]
end
local function reject(operation, data, expected, body, overrides)
	run(operation, data, body, overrides)
	expect(status == expected, "expected HTTP " .. expected .. ", got " .. status)
	expect(#calls == 0 and opens == 0, "rejected request must not execute or write")
end

ctx.authuser = "guest"
reject("rpc", { csrf = "csrf" }, 403)
ctx.authuser = "root"
reject("rpc", { csrf = "bad" }, 403)
reject("rpc", {}, 405, nil, { REQUEST_METHOD = "GET" })
reject("rpc", { csrf = "csrf" }, 400, nil, { CONTENT_LENGTH = "9000" })
reject("rpc", { csrf = "csrf", command = "/bin/sh", args = { "-c", "touch /tmp/unexpected" } }, 400)
reject("rpc", { csrf = "csrf", command = "/usr/libexec/lucky-call", args = { "service", "anything" } }, 400)
reject("rpc", { csrf = "csrf", command = "/usr/libexec/lucky-call", args = { "set-port", "1\n2" } }, 400)
reject("archive", { csrf = "csrf", operation = "cleanup", workspace = "../etc" }, 400)
ctx.authsession = "another-session"
reject("archive", { csrf = "csrf", operation = "cleanup", workspace = token }, 400)
ctx.authsession = "session"
local result = run("rpc", { csrf = "csrf", command = "/usr/libexec/lucky-call", args = { "status" } })
expect(status == 200 and result.code == 0 and #calls == 1, "valid whitelisted RPC")
expect(calls[1].ubus_rpc_session == nil, "root-only gateway must work with pre-upgrade LuCI sessions")
result = run("archive", { csrf = "csrf", operation = "backup", workspace = token })
expect(status == 200 and result == "streamed-result", "maintenance response must stream outside pcall")
print("PASS: root authentication, CSRF, method/size limits, command whitelist, session isolation and Lua 5.1 streaming")

local meta = { csrf = "csrf", workspace = token, name = "rules.json" }
result = run("upload", meta, { "BO", "DY\nabc", "def" }, { CONTENT_LENGTH = "11" })
expect(result.ok and files[work .. "/rules.json"] == "abcdef", "fragmented preamble and file must be streamed intact")
meta.csrf = "bad"
reject("upload", meta, 403, { "BODY\nabcdef" }, { CONTENT_LENGTH = "11" })
meta.csrf = "csrf"; meta.name = "../other"
reject("upload", meta, 400, { "BODY\nabcdef" }, { CONTENT_LENGTH = "11" })
meta.name = "core.tar.gz"
reject("upload", meta, 400, { "BODY\n" }, { CONTENT_LENGTH = tostring(64 * 1024 * 1024 + 6) })
reject("upload", meta, 400, { string.rep("x", 1025) }, { CONTENT_LENGTH = "1030" })
meta.name = "rules.json"
run("upload", meta, { "BODY\nshort" }, { CONTENT_LENGTH = "20" })
expect(status == 400 and files[work .. "/upload.part"] == nil and files[work .. "/rules.json"] == nil,
	"interrupted upload must not leave a target or partial file")
print("PASS: bounded upload preamble, CSRF before file creation, exact filename/size checks and interrupted upload cleanup")
