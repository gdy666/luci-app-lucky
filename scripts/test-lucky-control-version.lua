-- Run with Lua 5.1; the version decision does not access the filesystem.
package.preload["nixio.fs"] = function() return {} end
package.preload["nixio"] = function() return {} end
package.preload["luci.jsonc"] = function() return {} end
local core = dofile("luci-app-lucky/root/usr/lib/lua/luci/lucky_core.lua")
for _, case in ipairs({
 {"2.27.2", false}, {"3.3.99", false}, {"3.4.0", true},
 {"v3.4.0", true}, {"3.4.1", true}, {"3.10.0", true}, {"4.0.0", true},
 {"dev", false}, {"", false}, {"3.4", false}, {"3.4.0-beta", false}
}) do
 assert(core.supports_local_control(case[1]) == case[2], case[1])
end
assert(not core.supports_local_control(nil))
print("PASS: local control starts at stable v3.4.0; older and unknown cores use offline saves")
