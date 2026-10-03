-- SPDX-License-Identifier: Apache-2.0

module("luci.controller.lucky", package.seeall)

function index()
	if not nixio.fs.access("/etc/config/lucky") then
		return
	end

	entry({ "admin", "services", "lucky" }, view("lucky/config"), _("Lucky"), 60).dependent = true
end
