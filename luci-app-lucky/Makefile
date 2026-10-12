# SPDX-License-Identifier: Apache-2.0

include $(TOPDIR)/rules.mk
include $(INCLUDE_DIR)/version.mk

PKG_NAME:=luci-app-lucky
PKG_VERSION:=3.0.0
PKG_RELEASE:=12

LUCI_TITLE:=LuCI support for Lucky
LUCI_DESCRIPTION:=Manage the Lucky service and its basic web settings.
LUCI_DEPENDS:=+lucky +rpcd-mod-file +lua +luci-lib-nixio +luci-lib-jsonc +luci-lib-ip
LUCI_PKGARCH:=all

# Keep Windows checkout permissions out of the installed package.
define LuckyFilePermissions
	find $(PKG_BUILD_DIR)/root $(PKG_BUILD_DIR)/htdocs -type d -exec chmod 0755 {} +
	find $(PKG_BUILD_DIR)/root $(PKG_BUILD_DIR)/htdocs -type f -exec chmod 0644 {} +
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/lucky-backup
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/lucky-diagnostics
endef
Hooks/Prepare/Post += LuckyFilePermissions

ifneq ($(filter 19.07%,$(VERSION_NUMBER)),)
  LUCI_DEPENDS+=+luci-compat
endif

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
