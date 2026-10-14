-- SPDX-License-Identifier: Apache-2.0
-- Run from the repository root with Lua 5.1, as used by legacy LuCI.
local config_exists = true
package.preload["nixio.fs"] = function()
	return { access = function(path)
		assert(path == "/etc/config/lucky")
		return config_exists
	end }
end

dofile("luci-app-lucky/root/usr/lib/lua/luci/controller/lucky.lua")
local controller = package.loaded["luci.controller.lucky"]

local function check(label, has_config, view_function, expected)
	config_exists = has_config
	local entries = {}
	-- LuCI replaces index()'s environment with the dispatcher scope. There is
	-- deliberately no global nixio and legacy dispatchers have no view().
	local scope = setmetatable({
		view = view_function,
		template = function(name) return { type = "template", view = name } end,
		call = function(name) return { type = "call", action = name } end,
		_ = function(text) return text end,
		entry = function(path, target, title, order)
			local route = table.concat(path, "/")
			assert(route == "admin/services/lucky" or route == "admin/services/lucky/legacy")
			if route == "admin/services/lucky" then assert(title == "Lucky" and order == 60) end
			local node = { target = target, route = route }
			entries[#entries + 1] = node
			return node
		end
	}, { __index = _G })
	setfenv(controller.index, scope)
	local ok, err = pcall(controller.index)
	assert(ok, label .. ": menu construction crashed: " .. tostring(err))
	if not has_config then
		assert(#entries == 0, label .. ": missing config should not create a menu")
	else
		local panel = entries[#entries]
		assert(panel.dependent == true and panel.target.type == expected)
		assert(panel.target.view == (expected == "view" and "lucky/config" or "lucky/legacy"))
		if expected == "view" then
			assert(#entries == 1, "Native LuCI must not expose the legacy API")
		else
			local api = entries[1]
			assert(#entries == 2 and api.target.action == "legacy_api" and api.leaf == true)
			assert(api.sysauth == "root" and api.sysauth_authenticator == false)
		end
	end
	print("PASS: " .. label)
end

local function view(name) return { type = "view", view = name } end
check("JavaScript LuCI keeps the normal page", true, view, "view")
check("Lua-only LuCI does not break the global menu", true, nil, "template")
check("a non-function view cannot crash the dispatcher", true, {}, "template")
check("missing config on JavaScript LuCI", false, view)
check("missing config on Lua-only LuCI", false, nil)
