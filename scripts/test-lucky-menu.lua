-- Run with Lua 5.1 from the repository root. No real ACLs are modified.
local group = "luci-app-lucky"
local sessions, logins, grants, unavailable = {}, {}, {}, false
local acl = { [group] = {
	read = { ubus = { file = { "stat" } }, uci = { "lucky" } },
	write = { file = { ["/usr/libexec/lucky-backup prepare"] = { "exec" } }, uci = { "lucky" } }
}, unrelated = { write = { ubus = { system = { "reboot" } } } } }
package.preload["nixio.fs"] = function() return { readfile = function(path)
	assert(path == "/usr/share/rpcd/acl.d/luci-app-lucky.json"); return "ACL"
end } end
package.preload["luci.jsonc"] = function() return { parse = function(value) assert(value == "ACL"); return acl end } end
package.preload["uci"] = function() return { cursor = function() return { foreach = function(_, config, section, fn)
	assert(config == "rpcd" and section == "login"); for _, login in ipairs(logins) do fn(login) end
end } end } end
package.preload["ubus"] = function() return { connect = function() return {
	call = function(_, object, method, args)
		assert(object == "session")
		if method == "list" then
			if unavailable then return nil, 4 end
			return unpack(sessions)
		end
		assert(method == "grant")
		grants[#grants + 1] = args
		if args.ubus_rpc_session == string.rep("f", 32) then return nil, 4 end
	end,
	close = function() end
} end } end

local function session(id, name, expires)
	return { ubus_rpc_session = string.rep(id, 32), data = { username = name }, expires = expires or 600 }
end
local function run()
	grants = {}
	dofile("luci-app-lucky/root/usr/lib/lua/luci/lucky_menu.lua")
end
local function granted(id, scope, object, method)
	for _, g in ipairs(grants) do
		if g.ubus_rpc_session == string.rep(id, 32) and g.scope == scope then
			for _, pair in ipairs(g.objects) do if pair[1] == object and pair[2] == method then return true end end
		end
	end
	return false
end
logins = {
	{ username = "root", read = { "*" }, write = { "*" } },
	{ username = "reader", read = { "luci-app-luck?" }, write = {} },
	{ username = "denied", read = { "*", "! luci-app-luck[y]" }, write = { "*", "!luci-*" } },
	{ username = "other", read = { "luci-app-other" }, write = {} },
	{ username = "writer", write = { group } },
	{ username = "injection", read = { "'; exit 0; #", "$(exit 0)*" } }
}
sessions = { session("0", "root"), session("1", "root"), session("2", "root"), session("3", "reader"),
	session("4", "denied"), session("5", "other"), session("6", "unknown"), session("7", "root", 0),
	session("8", "writer"), session("9", "injection"), session("f", "root") }
run()
for _, id in ipairs({ "1", "2", "8" }) do
	assert(granted(id, "access-group", group, "read"))
	assert(granted(id, "access-group", group, "write"))
	assert(granted(id, "file", "/usr/libexec/lucky-backup prepare", "exec"))
end
assert(granted("3", "access-group", group, "read"))
assert(not granted("3", "access-group", group, "write"))
for _, g in ipairs(grants) do
	assert(g.ubus_rpc_session:match("^[1238f]+$"), "unauthorized or expired session was granted access")
	for _, pair in ipairs(g.objects) do assert(pair[2] ~= "reboot", "unrelated ACL was applied") end
end
unavailable = true
assert(not pcall(run), "missing ubus sessions must be reported")
assert(#grants == 0)
print("PASS: multiple sessions, original UCI permissions, deny precedence, read-only access, expired sessions and shell injection")
