# SPDX-License-Identifier: GPL-3.0-only
#
# Copyright (C) 2022-2023  gdy  
# 
# This is free software, licensed under the Apache License, Version 2.0 .
#
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-lucky
PKG_VERSION:=2.2.2
PKG_RELEASE:=1

LUCI_TITLE:=LuCI Support for  lucky 
LUCI_DEPENDS:=+lucky +luci-compat
LUCI_PKGARCH:=all


define Package/$(PKG_NAME)/install
	$(INSTALL_BIN) ./root/usr/bin/luckyarch $(1)/usr/bin/luckyarch
endef

include $(TOPDIR)/feeds/luci/luci.mk




# call BuildPackage - OpenWrt buildroot signature
