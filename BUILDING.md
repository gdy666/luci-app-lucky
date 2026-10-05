# 构建说明

## 支持的核心架构

| OpenWrt 目标架构 | Lucky 上游资源 |
| --- | --- |
| `aarch64` | `arm64` |
| ARMv7 / ARMv6 / 受支持的 ARMv5 | `armv7` / `armv6` / `armv5` |
| `x86_64` / `i386` | `x86_64` / `i386` |
| MIPS 大端、软浮点/硬浮点 | `mips_softfloat` / `mips_hardfloat` |
| MIPS 小端、软浮点/硬浮点 | `mipsle_softfloat` / `mipsle_hardfloat` |
| `riscv64` | `riscv64` |

`lucky` 不再声明为 `all`。即使多个设备都叫 ARM64，它们的 OpenWrt 包架构可能是 `aarch64_cortex-a53`、`aarch64_cortex-a72` 或其他值，因此应使用设备所属 target/subtarget 对应的 SDK 构建。只有 OpenWrt 版本和 `ARCH_PACKAGES` 完全一致时，才建议共用同一个核心 APK/IPK。`luci-app-lucky` 本身为 `all`，但仍建议与目标 OpenWrt 分支一起构建，以获得匹配的依赖元数据和包格式。

## Windows + WSL 构建环境

Windows 10/11 加 WSL2 Ubuntu 可以完成本项目的交叉编译、IPK/APK 打包和静态检查，但 OpenWrt 官方不正式支持 WSL，正式发布环境仍优先推荐原生 GNU/Linux。目标程序的启停、网络访问和升级验收还需要真实路由器或匹配的 QEMU 环境。

必须使用普通用户构建，不要使用 root；SDK、源码路径和 `PATH` 均不能包含空格。OpenWrt 构建系统要求区分文件名大小写，建议把 SDK 和源码放在 WSL 的 Linux 文件系统（例如 `~/src`），不要放在 `/mnt/c` 下长期编译。为了防止 Windows PATH 中的空格或 Windows 工具干扰，可以在 WSL 中创建 `/etc/wsl.conf`：

```ini
[interop]
appendWindowsPath=false
```

然后在 PowerShell 7 中执行 `wsl --shutdown`，重新打开 Ubuntu。

在 Ubuntu 中安装常用依赖：

```bash
sudo apt update
sudo apt install bc binutils-gold build-essential ca-certificates ccache clang \
  flex bison g++ gawk gcc-multilib gettext git libelf-dev liblzma-dev \
  libncurses-dev libssl-dev pkg-config python3 python3-dev python3-setuptools \
  rsync subversion swig texinfo time unzip wget xxd xsltproc xz-utils \
  zlib1g-dev zstd file
```

然后从 [OpenWrt 官方下载站](https://downloads.openwrt.org/) 下载与设备版本、target 和 subtarget 完全对应的 SDK。一个 SDK 只输出该目标架构的软件包；要发布多种 ARM64 或其他架构，需要分别运行对应 SDK。

## 使用官方 SDK 构建

先在路由器上确认版本和包架构，不要只根据“ARM64”判断：

```sh
. /etc/openwrt_release
printf '%s %s %s\n' "$DISTRIB_RELEASE" "$DISTRIB_TARGET" "$DISTRIB_ARCH"
```

以下命令在 SDK 根目录执行。把 `/home/user/src/luci-app-lucky` 换成仓库的 WSL 绝对路径：

```bash
[ -f feeds.conf ] || cp feeds.conf.default feeds.conf
feed_line='src-link lucky /home/user/src/luci-app-lucky'
if grep -q '^src-link lucky ' feeds.conf; then
  grep -Fxq "$feed_line" feeds.conf || {
    echo 'feeds.conf 中已有另一个 lucky 源码路径，请先修正' >&2
    exit 1
  }
else
  echo "$feed_line" >> feeds.conf
fi
./scripts/feeds update -a
./scripts/feeds install -p lucky -f lucky luci-app-lucky

printf '%s\n' \
  'CONFIG_PACKAGE_lucky=m' \
  'CONFIG_PACKAGE_luci-app-lucky=m' >> .config
make defconfig

make package/feeds/lucky/lucky/compile V=s
make package/feeds/lucky/luci-app-lucky/compile V=s
```

也可以使用仓库脚本简化同样的流程：

```bash
bash /home/user/src/luci-app-lucky/scripts/build-sdk.sh "$PWD" \
  /home/user/src/luci-app-lucky
```

OpenWrt 19.07 SDK 的先决条件检查仍要求已经淘汰的 Python 2。在 Ubuntu 24.04 等新环境中，本项目本身不调用 Python 2，可仅对 19.07 构建使用：

```bash
OPENWRT_FORCE=1 bash /home/user/src/luci-app-lucky/scripts/build-sdk.sh "$PWD" \
  /home/user/src/luci-app-lucky
```

`OPENWRT_FORCE=1` 只对 19.07 SDK 生效，会创建旧构建系统的宿主检查 stamp，向 `make` 显式传入 `FORCE=1`，并将旧 LuCI 中写死的 `contrib/lemon` 宿主编译规则精确调整为 `cc -std=gnu89`，以兼容当前 GCC 的默认 C 语言标准。这会跳过整个旧 SDK 宿主检查，因此除已淘汰的 Python 2 外，上述编译依赖仍必须完整安装；脚本会拒绝在新版 SDK 中使用此选项，也会在旧 LuCI 规则不匹配时停止。

输出位于 `bin/packages/<架构>/lucky/` 附近：

- OpenWrt 25.12/Snapshot：`.apk`
- OpenWrt 24.10 及更旧版本：`.ipk`

构建 LuCI 包时，`luci-i18n-lucky-zh-cn` 会由 LuCI 构建系统生成。

核心包从 GitHub Releases 下载指定版本资源，使用 `PKG_HASH:=skip`，更新版本无需维护架构哈希表。

## 自动检查

GitHub Actions 会执行 JSON、JavaScript、Shell 和翻译检查。21.02–25.12 使用官方 OpenWrt SDK Action，19.07 使用官方 SDK 压缩包单独构建；矩阵中的 ARM64 只是代表性兼容验证，不是可直接发布到全部 `aarch64_*` 设备的通用核心包。发布其他设备包时，仍应在该设备对应 SDK 中完成一次构建验证。

## 本地一次构建全部支持架构

全架构发布不依赖 GitHub Actions。Windows 本地安装并启动 Docker Desktop 后，
在仓库目录使用 PowerShell 7 执行：

```powershell
pwsh -File .\scripts\build-all-local.ps1
```

脚本会先把当前工作树（包括未提交和未跟踪文件）复制为 Docker Linux 卷中的
不可变只读快照，再在本机拉取 OpenWrt 官方 SDK 容器。默认同时运行 2 个外层
任务、每个 SDK 使用 2 个 make job，并生成 57 个可安装软件包：

- OpenWrt 25.12.5：26 种受支持包架构的 `lucky` APK；
- OpenWrt 24.10.8：27 种受支持包架构的 `lucky` IPK；
- 每种格式各一份 `all` 架构的 `luci-app-lucky` 和简体中文翻译包；
- 汇总后的 `SHA256SUMS`、`MANIFEST.json`、`SDK-LOCK.json`、双语构建说明
  和完整目录树。

结果默认保存在 `dist/build-all/`。核心包按
`packages/openwrt-<版本>/<apk|ipk>/<包架构>/` 分目录保存，因此同名 APK
不会互相覆盖；架构无关的 LuCI 包位于 `all/` 目录。

构建支持断点续跑：再次执行会跳过已经完整生成的架构，只重试缺失或失败项。
续跑身份同时包含源码指纹、OpenWrt 版本和 53 个 SDK 镜像 digest；任一项变化时
脚本会拒绝混用旧产物，需更换输出目录或显式使用 `-Force`。
常用选项：

```powershell
# 最多同时构建 3 个架构
pwsh -File .\scripts\build-all-local.ps1 -Jobs 3

# 两个容器并行，每个容器最多使用 2 个 make job（默认值）
pwsh -File .\scripts\build-all-local.ps1 -Jobs 2 -BuildJobs 2

# 只验证矩阵、版本和 53 个官方 SDK 标签，不开始编译
pwsh -File .\scripts\build-all-local.ps1 -ValidateOnly

# 只构建一个目标，用于测试本地环境
pwsh -File .\scripts\build-all-local.ps1 -Only apk:x86_64

# 全部成功后删除本次使用的 SDK 镜像以回收空间
pwsh -File .\scripts\build-all-local.ps1 -RemoveImages
```

默认保留 SDK 镜像，以便失败重试和下次增量构建。`-RemoveImages` 只删除矩阵中
本次实际构建使用的精确镜像标签，不执行全局 Docker 清理。建议先保持 `Jobs=2`；
并行度过高会同时占用大量内存、磁盘 I/O 和网络带宽。

这里的“全部架构”指 OpenWrt 官方软件包仓库中、同时被 Lucky 上游二进制支持
的 package architecture。上游没有提供 ARMv4/FA526、`armeb`、LoongArch、
MIPS64、PowerPC 等二进制，因此这些 OpenWrt 架构不会生成不可运行的空包。
特别是 Gemini 的 `arm_fa526` 属于 ARMv4，不能用 ARMv5 包冒充。架构清单集中
维护在 `scripts/build-matrix.json`，静态检查会拒绝重复、无效或意外缺失的条目。

全架构发布矩阵使用当前最新 IPK 基线 24.10.x 和 APK 基线 25.12.x。GitHub CI
只使用 19.07、21.02、22.03、23.05、24.10 和 25.12 的少量代表性 SDK 验证
源码兼容性，不生成全架构发布集合；24.10 构建的 IPK 不应被描述为 19.07 的
通用包。若要发布某个旧版 OpenWrt 的完整架构集合，仍需为该版本维护独立矩阵。
