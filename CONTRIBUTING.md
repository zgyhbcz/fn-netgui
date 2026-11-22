# 贡献指南

感谢你愿意改进 fn-netgui。这个项目面向飞牛 fnOS 的自用网络配置，改动原则是**小、可验证、可回滚**。

## 开发环境

- Node.js ≥ 18（推荐 22，与 fnOS 的 `nodejs_v22` 对齐）
- Python ≥ 3.9（仅用于打包与校验脚本，需要 `lxml` 跑 GUI 检查）
- 可选：一台 fnOS 设备或虚拟机做真机验证

```bash
git clone <repo-url> && cd fn-netgui
node tests/plans.test.js          # 纯函数测试
python3 tools/check_ui.py         # GUI 选择器一致性
python3 tools/build_fpk.py        # 产出 dist/fn-netgui_<ver>_all.fpk
```

本地跑 GUI（非 root 即只读模式，不会真的改网络）：

```bash
node app/server/server.js         # http://127.0.0.1:38471
```

## 提交前必须通过

```bash
node tests/plans.test.js     # 必须 0 failed
python3 tools/check_ui.py    # 必须 GUI 静态检查通过
python3 tools/build_fpk.py   # 必须打包成功
```

CI 会在这三条之外再用 Node 18/20/22 跑一遍测试。

## 代码约定

| 位置 | 约定 |
| --- | --- |
| `cmd/*` | 纯 bash，LF 换行，`#!/bin/bash` 开头，`status` 返回 0/3，失败信息写 `$TRIM_TEMP_LOGFILE` |
| `app/server/lib/plans.js` | 只做「payload → argv 计划」，**不执行**任何命令，便于测试 |
| `app/server/lib/validate.js` | 所有进入 argv 的值必须在这里过白名单，正则优先于黑名单 |
| 命令执行 | 只允许 `execFile(bin, argv)`，**禁止**拼 shell 字符串、禁止 `exec`/`sh -c` |
| 连接命名 | 本应用创建的连接统一 `netgui-` 前缀；越权操作必须报错而不是静默失败 |
| `app/ui/*` | 原生 JS/CSS，不引入框架与构建步骤（保证离线零依赖） |
| 文案 | 面向用户的文案用简体中文；代码注释与提交信息用英文（或中文均可，保持同文件内一致） |

## 提交信息

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
feat(shared): 支持自定义 DNS
fix(hotspot): 5GHz 失败时回退 2.4GHz 并提示
docs: 补充 OVS 前置条件
chore(ci): 增加 Node 22 矩阵
```

## Pull Request

1. 一个 PR 只做一件事，附上「为什么」而不是只写「改了什么」。
2. 涉及命令生成或校验规则的改动，必须同步更新 `tests/plans.test.js`。
3. 涉及界面元素的改动，必须保证 `python3 tools/check_ui.py` 通过。
4. 涉及网络行为的改动，请在描述里写清验证方式（真机截图/命令输出最佳）。

## 报告问题

请使用 Issue 模板，并附上：

- fnOS 版本（`cat /etc/trim-release`）、架构、`nmcli --version`
- 相关命令的**预览文本**与执行输出
- `var/netgui.log` 末尾 50 行（注意先删除 MAC、SSID 等敏感信息）

## 安全

发现安全问题请**不要**开公开 Issue，按 [SECURITY.md](SECURITY.md) 的流程私下报告。

## 维护者：发布流程

首次把仓库推上 GitHub（需要 `repo` + `workflow` 权限的 PAT，`workflow` 是推 `.github/workflows/` 所必需）：

```powershell
$env:GH_TOKEN = "<PAT>"
pwsh -File tools/publish.ps1                       # 建仓库 + 设 topics + 推送 main
```

发布版本（CI 会自动构建 `.fpk` 并挂到 Release）：

```bash
# 1. 更新 CHANGELOG.md，提交
# 2. 打 tag 并推送，触发 .github/workflows/release.yml
git tag -a v1.0.1 -m "v1.0.1"
git push origin v1.0.1
```

产物校验（本地等价于 CI 的检查）：

```bash
python3 tools/build_fpk.py && python3 tools/verify_fpk.py dist/*.fpk
```
