-- Copyright (C) 2021-2022  sirpdboy  <herboy2008@gmail.com> https://github.com/sirpdboy/luci-app-lucky 
-- Licensed to the public under the Apache License 2.0.

module("luci.controller.lucky", package.seeall)

function index()
	if not nixio.fs.access("/etc/config/lucky") then
		return
	end

	entry({"admin",  "services", "lucky"}, alias("admin", "services", "lucky", "setting"),_("Lucky"), 57).dependent = true
	entry({"admin", "services", "lucky", "setting"}, cbi("lucky/lucky"), _("Base Setting"), 20).leaf=true
	entry({"admin", "services", "lucky_status"}, call("act_status"))
	entry({"admin", "services", "lucky_info"}, call("lucky_info"))
	entry({"admin", "services", "lucky_set_config"}, call("lucky_set_config"))
	entry({"admin", "services", "lucky_service"}, call("lucky_service"))
end




function act_status()
	local sys  = require "luci.sys"
	local e = { }
	e.running = sys.call("pidof lucky >/dev/null") == 0
	luci.http.prepare_content("application/json")
	luci.http.write_json(e)
end




function lucky_info()	
	local e = { }
	

	
	local luckyInfo = luci.sys.exec("/usr/bin/lucky -info")
	if (luckyInfo~=nil)
	then
		e.luckyInfo = luckyInfo
		local configObj = GetLuckyConfigureObj()
		if (configObj~=nil)
		then
			e.LuckyBaseConfigure = configObj["BaseConfigure"]
		end

	end
	e.luckyArch = luci.sys.exec("/usr/bin/luckyarch")
	--e.runStatus = luci.sys.call("pidof lucky >/dev/null") == 0
	

	luci.http.prepare_content("application/json")
	luci.http.write_json(e) 
end 


function lucky_set_config()
	local key = luci.http.formvalue("key") 
	local value = luci.http.formvalue("value") 

	local e = { }
	e.ret = 1
	if (key == "admin_http_port")
	then
		e.ret =setLuckyConf("AdminWebListenPort",value)
	end

	if(key=="admin_safe_url")
	then
		e.ret =setLuckyConf("SetSafeURL",value)
	end

	if(key=="reset_auth_info")
	then
		setLuckyConf("AdminAccount","666")
		e.ret =setLuckyConf("AdminPassword","666")
	end
	if(key=="switch_Internetaccess")
	then
		e.ret =setLuckyConf("AllowInternetaccess",value)
	end




	luci.http.prepare_content("application/json")
	luci.http.write_json(e) 
end


function lucky_service()
	local action = luci.http.formvalue("action") 
	if (action=="restart")
	then
		luci.sys.exec("uci set  lucky.@lucky[0].enabled=1")
		luci.sys.exec("uci commit")
		luci.sys.exec("/etc/init.d/lucky restart")
	end

	if (action=="start")
	then
		luci.sys.exec("uci set  lucky.@lucky[0].enabled=1")
		luci.sys.exec("uci commit")
		luci.sys.exec("/etc/init.d/lucky start")
	end

	if (action=="stop")
	then
		luci.sys.exec("uci set  lucky.@lucky[0].enabled=0")
		luci.sys.exec("uci commit")
		luci.sys.exec("/etc/init.d/lucky stop")
	end

	-- local e = { }
	-- e.fuck= action
	-- luci.http.prepare_content("application/json")
	-- luci.http.write_json(e) 

end


function trim(s)
	return (string.gsub(s, "^%s*(.-)%s*$", "%1"))
end


function GetLuckyConfigureObj()
	configPath = trim(luci.sys.exec("uci get lucky.@lucky[0].config"))
	local configContent = nixio.fs.readfile(configPath)
	if (configContent==nil)
	then
		return nil
	end
	configObj = luci.jsonc.parse(trim(configContent))
	return configObj
end



function setLuckyConf(key,value)
	configPath = trim(luci.sys.exec("uci get lucky.@lucky[0].config"))

	cmd = "/usr/bin/lucky -c "..configPath.." -setconf ".."-key "..key.." -value "..value
	if (value=="")
	then
		cmd = "/usr/bin/lucky -c "..configPath.." -setconf ".."-key "..key
	end

	return luci.sys.call(cmd)
end