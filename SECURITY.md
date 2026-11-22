# 安全策略

## 这个应用为什么需要 root

`fn-netgui` 通过 `nmcli` / `ovs-vsctl` 修改网络配置，这两个操作在 Linux 上必须特权。因此 `config/privilege` 声明了 `run-as: root`。

这意味着：**任何能访问该端口的人都能改这台 NAS 的网络**。所以本项目把攻击面收敛到最小：

| 防护 | 实现 |
| --- | --- |
| 网络边界 | 仅接受回环与 RFC1918/链路本地地址；非私网来源直接 403（[server.js](app/server/server.js) `isPrivatePeer`） |
| CSRF | 写接口要求自定义头 `X-NetGUI-Request: 1` 并校验 `Origin` 端口/主机 |
| 命令注入 | 全链路 `execFile(bin, argv)`，禁止 shell；网口名、连接名、IP、MAC、SSID 全部正则白名单 |
| 越权改配置 | 只允许操作 `netgui-*` 连接；删除/编辑前校验前缀 |
| 路径穿越 | 静态资源解析后必须位于 `app/ui/`，仅白名单后缀 |
| 资源耗尽 | 请求体上限 64 KiB，命令超时 45 s，执行串行化 |

## 已知风险（请自行评估）

1. **root 进程**：HTTP 服务本身以 root 运行。若你所在环境不可接受，把 `config/privilege` 改成 `"run-as": "package"`，应用会降级为「只读预览」，由你手工 `sudo` 执行命令。
2. **无登录态**：服务不校验 fnOS 登录态，只依赖「内网 + 端口不可达公网」。**不要**把 38471 端口映射到公网。
3. **克隆 MAC**：设置 MAC 会改变设备对外身份，请确保所用 MAC 在你的网络策略中合法。

## 报告漏洞

请通过 GitHub 的 [Private vulnerability reporting](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) 提交，或邮件联系维护者（见仓库主页）。

请包含：影响版本、复现步骤、实际影响、建议修复方向。**不要**在公开 Issue 中披露可直接利用的细节。

我们会在 7 天内确认收到，并在修复发布后致谢（如你愿意署名）。
