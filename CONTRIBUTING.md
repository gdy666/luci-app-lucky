# 贡献说明

## 分支与提交

- 功能开发应在独立分支完成，通过验证后再合并到主分支。
- Git 提交信息必须同时包含英文和中文。
- 推荐标题格式：`English summary / 中文摘要`
- 需要正文时，先写英文说明，再写对应的中文说明。

示例：

```text
Modernize LuCI view and service integration / 现代化 LuCI 界面与服务集成

Use a JavaScript View and a validated helper command.
使用 JavaScript View 和经过参数校验的辅助命令。
```

## 提交前检查

```bash
shfmt -d -sr -s lucky/files/lucky.init lucky/files/lucky-call scripts/build-sdk.sh
sh -n lucky/files/lucky.init
sh -n lucky/files/lucky-call
msgfmt --check --check-compatibility -o /dev/null luci-app-lucky/po/zh_Hans/lucky.po
python3 scripts/check-po.py luci-app-lucky/po/zh_Hans/lucky.po \
  luci-app-lucky/htdocs/luci-static/resources/view/lucky/config.js
python3 scripts/check-build-matrix.py scripts/build-matrix.json
python3 scripts/check-sdk-tags.py scripts/build-matrix.json \
  --apk-version 25.12.5 --ipk-version 24.10.8
python3 -m json.tool luci-app-lucky/root/usr/share/luci/menu.d/luci-app-lucky.json >/dev/null
python3 -m json.tool luci-app-lucky/root/usr/share/rpcd/acl.d/luci-app-lucky.json >/dev/null
node -e "new Function(require('fs').readFileSync(process.argv[1], 'utf8'));" \
  luci-app-lucky/htdocs/luci-static/resources/view/lucky/config.js
```

涉及包元数据、依赖、服务脚本或 LuCI 路由的改动，还应至少使用一个受支持版本的官方 OpenWrt SDK 完成实际构建。

调整全架构发布范围时，必须同时更新 `scripts/build-matrix.json`、`BUILDING.md`
中的架构数量和 `scripts/build-all-local.ps1` 的完整性断言。全架构发布只在
本地通过 Docker SDK 容器执行，不应添加到每次 push 或 pull request。
