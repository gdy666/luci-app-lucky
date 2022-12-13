-- Copyright (C) 2021-2022  sirpdboy  <herboy2008@gmail.com> https://github.com/sirpdboy/luci-app-lucky

local m, s ,o

local m = Map("lucky", translate("Lucky"), translate("ipv4/ipv6 portforward,ddns,reverseproxy proxy,wake on lan,IOT and more...") )

m:section(SimpleSection).template  = "lucky/lucky_status"

s = m:section(TypedSection, "lucky", translate("Basic Settings"))
s.addremove=false
s.anonymous=true

--o=s:option(Flag,"enabled",translate("Enable"))
--o.default=0

o = s:option( Value, "config", translate("Config file path"),
	translate("The path to store the config file"))
o.placeholder = "/etc/config/lucky.daji/lucky.conf"


m.apply_on_parse = true
m.on_after_apply = function(self,map)
	luci.sys.exec("/etc/init.d/lucky restart")
end

return m
