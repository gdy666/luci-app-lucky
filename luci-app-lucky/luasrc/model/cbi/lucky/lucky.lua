-- 
local m, s ,o

local m = Map("lucky", translate("Lucky"), translate("ipv4/ipv6 portforward,ddns,reverseproxy proxy,wake on lan,IOT and more...") )

m:section(SimpleSection).template  = "lucky/lucky_status"

s = m:section(TypedSection, "lucky", translate("Basic Settings"))
s.addremove=false
s.anonymous=true

--o=s:option(Flag,"enabled",translate("Enable"))
--o.default=0

o = s:option( Value, "configdir", translate("Config dir path"),
	translate("The path to store the config file"))
o.placeholder = "/etc/config/lucky.daji"


m.apply_on_parse = true
m.on_after_apply = function(self,map)
	luci.sys.exec("/etc/init.d/lucky restart")
end

return m
