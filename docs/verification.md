# Windows 验证记录

## 1.1.0：快捷 Skill

- `npm test`：41 项全部通过，包含快捷 Skill 安装/重装/卸载、旧 manifest 升级、用户同名/改动冲突、事务回滚以及 Windows 路径大小写回归。
- skill-creator 的验证器校验两个 Codex SKILL.md 通过；Claude 扩展 frontmatter 与 Codex openai.yaml 也已解析校验。
- 本机已安装 Claude 的 to-codex，以及 Codex 的 to-claude、claude-sessions。doctor/test 报告 skills.installed=true、skills.valid=true，两个 stdio MCP 正常连接。
- 真实 Claude CLI 输入 `/to-codex`，正确加载入口并询问缺失的任务，没有发送空任务。
- Codex 原生 app-server 的 skills/list 实测发现两个 Skill，均 enabled=true，并正确返回中文界面名称；不需要模型调用即可验证本地技能发现。
- 额外尝试了 Codex CLI 用模型执行 claude-sessions，试跑因超时未完成，不据此宣称完整模型驱动流程成功。MCP 只读列表调用及原生 Skill 发现分别已独立验证。
- 现有正在运行的宿主可能缓存 Skill 菜单，安装/更新后仍需重启或按宿主支持的方式刷新。

以下保留 1.0.0 的初始验证记录。

## 环境

Windows、Node 22.21.1、npm 10.9.4、Python 3.13.14、Codex CLI
0.169.0-alpha.11.1、Claude Code 2.1.328。版本用于复现，不是对所有后续版本的兼容承诺。

## 自动验证

`npm test`：35 项测试，覆盖原有双向消息核心，以及：

- 桌面版优先、queue 能力探测、npm Windows 原生可选包发现；
- JSON/TOML 无关配置、注释、空数组保留；
- 重复安装、卸载恢复、用户改动冲突保护；
- Windows 只读 manifest 导致最后提交失败时，配置和 settings 回滚；
- 安装准备期间 settings 被修改时，拒绝覆盖旧快照；
- manifest 已提交后清理 journal 失败时，保持配置一致并报告 warning；
- 真实子进程 stdio MCP 初始化、工具发现、只读状态调用；
- 中文和空格目录内的隔离 CLI 安装、重复配置、测试、卸载；
- 分发白名单、拒绝链接、live 测试必须显式指定 UUID。

## 本机集成验证

- 新独立目录的两个 MCP 均能初始化并列出预期工具。
- 用 MCP SDK 客户端向一个已知在线 Claude 终端发送固定测试标识，成功读回匹配的最终回复。
- 用 MCP SDK 客户端向一个指定 Codex 桌面聊天投递固定测试标识，成功读回匹配的最终回复。
- 本机的两个注册已迁移到独立目录并备份。Codex 无关配置及 node_repl 的空 args 保留；Claude 其他 MCP 保留。测试消息产生的 Claude 使用计数变化保留。
- 上述真实发送使用直接 MCP 客户端；重启宿主后由模型自主选择调用工具的流程，仍受其正常工具权限策略约束。

新建桌面聊天/可见 Claude 窗口的核心逻辑沿用已验证实现，当前版本回归测试包含新建、超时、登录/信任等待、幂等和重启恢复；本次独立化的真实消息测试使用已有会话，没有额外制造测试聊天和窗口。

## 发行包验证

白名单 ZIP 不含 node_modules、settings、manifest、回执、会话、备份和用户路径。
将 ZIP 解压到新的含中文、空格和 `&` 的目录，以隔离配置目录依次运行
install.cmd、test.cmd、uninstall.cmd，均退出 0。安装前不存在的 MCP 项在卸载后移除。
生成 SHA-256 文件供传输校验。接收方仍需要自己的依赖、登录和模型额度。
