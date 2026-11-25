# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.2] - 2026-11-25

### Fixed

- **桌面图标显示为占位图**：`app/ui/config` 的 `icon` 是 `images/icon_{0}.png`，`{0}` 会被替换成 `64` / `256`，所以文件名必须是 `icon_64.png` / `icon_256.png`；原来打成 `icon-64.png`（短横线）导致取不到图。已重命名并补上 `icon_128.png`，`verify_fpk.py` 增加「icon 占位符能否解析到真实文件」的检查。
- 顶部 `nmcli` 徽标原来直接回显 `nmcli tool, version 1.42.4`，现在只显示 `nmcli 1.42.4`，完整原文放到 tooltip。

### Added

- `docs/screenshot.png`：实机运行截图（fnOS 1.2.1011 / x86）与 README 界面预览。

## [1.0.1] - 2026-11-24

### Fixed

- **安装报「应用约束检查失败」**：`manifest` 的 `platform` 原来写 `all`，appcenter 的约束检查只接受 `x86` / `arm` / `loongarch` / `risc-v`（fnpack 报错 *must be one of x86, arm, loongarch, or risc-v*）。现改为按架构分发：`platform = x86`，并额外产出 `_arm` 包。
- 打包器与校验器现在都会拒绝非法 `platform`，避免同类问题再次流入产物；`build_fpk.py` 新增 `--platform x86|arm` 覆盖参数。

## [1.0.0] - 2026-11-22

### Added

- **NAT 共享**：`nmcli connection add/modify … ipv4.method shared`，自动 DHCP/DNS/NAT，支持自定义子网、DNS 与克隆 MAC。
- **OVS 桥接**：把网口作为 OVS 网桥端口（`ovs-vsctl add-port`），并提供前置校验（网桥不存在时给出启用 OVS 的指引）。
- **WiFi 热点**：`nmcli device wifi hotspot`，支持 2.4G/5G、自定义 SSID/密码/热点网段。
- **连接编辑**：静态 IP、网关、DNS、克隆 MAC，仅限本应用创建的 `netgui-*` 连接。
- **命令预览**：执行前展示确切 argv（含引号），只允许执行刚预览过的同一份计划。
- **执行结果回显**：逐步显示成功/失败/跳过与 stdout/stderr。
- **一键回滚**：删除本应用创建的连接或桥接端口，不触碰系统原有配置。
- **GUI 输入格式化**：MAC 自动补 `:`（含智能退格）、IP 自动补 `.`、中文标点转半角、DNS 逗号分隔。
- **安全收敛**：仅私网访问、`X-NetGUI-Request` CSRF 头 + Origin 校验、`execFile` 白名单参数、64 KiB 请求体上限、静态资源防穿越。
- **只读降级**：非 root 运行时自动禁用「执行」，仍可预览命令手工执行。
- **打包工具**：`tools/build_fpk.py` 无需 fnpack 即可生成确定性 `.fpk`（含结构校验与 `checksum` 写入）。
- **测试**：`tests/plans.test.js` 23 条纯函数测试；`tools/check_ui.py` GUI 选择器一致性检查。

### Known limitations

- 依赖 `run-as: root`（改网络必须特权），适合手动安装自用，不适合提交应用中心。
- `desktop_uidir=ui` 解析到 `app/ui`，尚未在真机 fnOS 上验证。
- OVS 端口由 `ovs-vsctl` 直接维护，NetworkManager 可能显示为 external。
