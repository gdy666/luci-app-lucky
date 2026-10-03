# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/version.mk

PKG_NAME:=luci-app-lucky
PKG_VERSION:=3.0.0
PKG_RELEASE:=1

LUCI_TITLE:=LuCI support for Lucky
LUCI_DESCRIPTION:=Manage the Lucky service and its basic web settings.
LUCI_DEPENDS:=+lucky +rpcd-mod-file
LUCI_PKGARCH:=all

ifneq ($(filter 19.07%,$(VERSION_NUMBER)),)
  LUCI_DEPENDS+=+luci-compat
endif

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
