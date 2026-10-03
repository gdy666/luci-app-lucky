# SPDX-License-Identifier: MIT

include $(TOPDIR)/rules.mk

PKG_NAME:=lucky
PKG_VERSION:=2.27.2
PKG_RELEASE:=2

PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=GDY666 <gdy666@foxmail.com>

LUCKY_ARCH:=

ifeq ($(ARCH),aarch64)
  LUCKY_ARCH:=arm64
endif
ifeq ($(ARCH),arm)
  ifeq ($(CONFIG_arm_v7),y)
    LUCKY_ARCH:=armv7
  else ifeq ($(CONFIG_arm_v6),y)
    LUCKY_ARCH:=armv6
  else ifneq ($(filter arm_arm926ej-s arm_xscale,$(ARCH_PACKAGES)),)
    LUCKY_ARCH:=armv5
  endif
endif
ifeq ($(ARCH),i386)
  LUCKY_ARCH:=i386
endif
ifeq ($(ARCH),x86_64)
  LUCKY_ARCH:=x86_64
endif
ifeq ($(ARCH),riscv64)
  LUCKY_ARCH:=riscv64
endif
ifeq ($(ARCH),mips)
  ifeq ($(CONFIG_SOFT_FLOAT),y)
    LUCKY_ARCH:=mips_softfloat
  else
    LUCKY_ARCH:=mips_hardfloat
  endif
endif
ifeq ($(ARCH),mipsel)
  ifeq ($(CONFIG_SOFT_FLOAT),y)
    LUCKY_ARCH:=mipsle_softfloat
  else
    LUCKY_ARCH:=mipsle_hardfloat
  endif
endif

LUCKY_HASH_arm64:=eb3a095238595193dab1fb486eed2a19d46190f37d4efd6630cc53e97d853466
LUCKY_HASH_armv5:=d83c92b8d247f589a9da27af6f6dfa1392893823fd5658033cea7f3440e130be
LUCKY_HASH_armv6:=39e469b70325d99bb8f728f82d09531b50ec18e4bb446b984577c8e6dcdd5249
LUCKY_HASH_armv7:=a69964e74d5daf01ee13ea7c127a3614883de3ce80b6a568ddabbe6252b0cebd
LUCKY_HASH_i386:=e05e02906b5ffd4d9b17071fbc8078102058430b03e1076a5424ffacfee35ca3
LUCKY_HASH_mipsle_hardfloat:=6d810aad76e2371c7cb1f31aea90d191e6599769fe72194980b5ea0651b4d337
LUCKY_HASH_mipsle_softfloat:=18e3a3c67dd55d04ddc343bff46e674fa6a97492bdf25f010f34b55807eb1ab3
LUCKY_HASH_mips_hardfloat:=d0bd22856175852b6e824fd2077547b070a0bdb204b79ad2235b168e920e2291
LUCKY_HASH_mips_softfloat:=9d369089f5571c0ab6921c1aae97265a0e2e155fdb060e9c08fa2b3a3700780c
LUCKY_HASH_riscv64:=edd79195938d1618c49d4e75c801ea701ce1057bf2aa1de4fa24b21db40e7b18
LUCKY_HASH_x86_64:=78adf3fa5e8869be0b1510cb7bcc755d57dccb13252989c8394a7207a392fe66

PKG_SOURCE:=lucky_$(PKG_VERSION)_Linux_$(LUCKY_ARCH).tar.gz
PKG_SOURCE_URL:=https://github.com/gdy666/lucky/releases/download/v$(PKG_VERSION)
PKG_HASH:=$(LUCKY_HASH_$(LUCKY_ARCH))
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)

include $(INCLUDE_DIR)/package.mk

define Package/lucky
  SECTION:=net
  CATEGORY:=Network
  TITLE:=Lucky network utility
  DEPENDS:=@(aarch64||arm||i386||mips||mipsel||riscv64||x86_64) @(!TARGET_gemini)
  URL:=https://github.com/gdy666/lucky
endef

define Package/lucky/description
 Lucky provides IPv4/IPv6 port forwarding, DDNS, Wake-on-LAN,
 reverse proxy, ACME automation and related network services.
endef

define Package/lucky/conffiles
/etc/config/lucky
endef

define Build/Prepare
	gzip -dc $(DL_DIR)/$(PKG_SOURCE) | $(HOST_TAR) -C $(PKG_BUILD_DIR) -xf -
	$(Build/Patch)
endef

define Build/Compile
endef

define Package/lucky/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/lucky $(1)/usr/bin/lucky
	$(INSTALL_DIR) $(1)/usr/libexec
	$(INSTALL_BIN) ./files/lucky-call $(1)/usr/libexec/lucky-call
	$(INSTALL_DIR) $(1)/usr/share/lucky
	echo '$(LUCKY_ARCH)' > $(1)/usr/share/lucky/arch
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/lucky.init $(1)/etc/init.d/lucky
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/luckyuci $(1)/etc/config/lucky
endef

$(eval $(call BuildPackage,lucky))
