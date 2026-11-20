# 工具与参数参考

以下 JSON 是 MCP 工具的参数示例，由宿主调用，不是直接粘贴到 CMD 执行的命令。示例 UUID 仅为格式占位，运行前必须替换为本机真实目标/请求 ID。

## 快捷入口（1.1.0）

Claude Code：`/to-codex [--thread UUID] 任务内容`。

Codex：`$to-claude [--session UUID] 任务内容`、`$claude-sessions`。桌面端也可从技能选择器按名称选择；CLI/IDE 支持 `/skills`。这些入口调用下方现有 MCP 工具，不新增工具或权限。

doctor 输出 skills.installed、skills.valid 和各 Skill 的安装路径。test 会校验文件仍与本次安装记录一致，但不代表当前已经运行的宿主刷新了 Skill 列表。

## Claude 中的 codex-queue

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| codex_queue_send | message 必填；threadId、cwd、requestId 可选 | 投递到指定聊天，或新建聊天 |
| codex_queue_wait | requestId 必填；timeoutSeconds、maxReplyChars 可选 | 等待关联请求的最终结果 |
| codex_queue_read | requestId 必填；maxReplyChars 可选 | 立即读取请求当前结果 |
| codex_queue_status | 无 | 查看配置路径、策略和默认目录等 |

向已有聊天发送：

```json
{
  "threadId": "11111111-1111-4111-8111-111111111111",
  "message": "请审查当前项目的错误处理，只分析并给出结论。"
}
```

新建聊天：

```json
{
  "cwd": "X:\\Projects\\example",
  "message": "请分析这个项目的启动流程，先不要修改文件。"
}
```

send 结果中的常用字段包括 requestId、threadId、delivery、queueId、createdNewThread 和 desktopLink。`delivery` 是投递信息，不是执行完成标志。

等待回复并选择限制返回量：

```json
{
  "requestId": "22222222-2222-4222-8222-222222222222",
  "timeoutSeconds": 35,
  "maxReplyChars": 4000
}
```

省略 maxReplyChars 返回完整回复。读取结果可能包括 status、reply、replyChars、truncated、timedOut。replyChars 表示完整回复字符数；truncated 表示这次读取是否被请求的字符上限截断。

## Codex 中的 claude-terminal

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| claude_terminal_list | 无 | 列出在线终端的 sessionId、name、cwd、pid、startedAt |
| claude_terminal_send | message 必填；sessionId、cwd、requestId 可选 | 投递到指定在线终端，或打开新终端 |
| claude_terminal_wait | requestId 必填；timeoutSeconds 可选 | 等待原生消息链对应的回复 |
| claude_terminal_read | requestId 必填 | 立即读取请求当前结果 |

继续指定在线会话：

```json
{
  "sessionId": "33333333-3333-4333-8333-333333333333",
  "message": "接着前面的分析，列出需要验证的三个边界。"
}
```

打开新终端：

```json
{
  "cwd": "X:\\Projects\\example",
  "message": "分析当前项目，给我一个简短的模块说明，不要改文件。"
}
```

send 常用返回字段：requestId、sessionId、cwd、delivery、stage、createdNewSession、terminalName 和 pid。stage 为 startup_pending 时，任务没有发出；先在新窗口处理提示，再用已知 sessionId 发起明确的新请求。

## 共同约束

| 项目 | 限制或行为 |
| --- | --- |
| ID | 必须是精确 UUID；不接受聊天标题或模糊匹配 |
| 新建目录 | 已存在的绝对目录；建议总是传调用方当前 cwd |
| 已有目录 | 不能改变已有会话的项目 |
| 任务消息 | 1..16,000 UTF-8 字节；不能含 NUL，Codex 消息也不能伪造本桥请求标记 |
| requestId | 可省略由桥接生成；相同 ID 不得用于不同内容/目标 |
| wait 时长 | 0..45 秒，默认 35 秒；超时后继续 wait/read |
| 读取内容 | 关联的最终文本；不作为完整历史、思考或工具日志接口 |

## 命令行维护

```bat
node bin/bridge.mjs install --json
node bin/bridge.mjs configure --json
node bin/bridge.mjs doctor --json
node bin/bridge.mjs test --json
node bin/bridge.mjs uninstall --json
```

install/configure/uninstall 支持 `--dry-run`。doctor/test 是检查命令；`test --live` 会实际发送消息并消耗接收方正常额度，须传 `--claude-session` 或 `--codex-thread`，至少一个。

路径选项：`--state-dir`、`--codex-home`、`--claude-home`、`--codex-config`、`--claude-config`、`--codex-bin`、`--claude-bin`、`--python-bin`。

| 环境变量 | 用途 |
| --- | --- |
| CODEX_CLAUDE_BRIDGE_HOME | 本项目用户状态目录 |
| CODEX_HOME | Codex 用户目录 |
| CLAUDE_CONFIG_DIR | Claude 自定义配置/会话目录 |
| CODEX_BRIDGE_CODEX_BIN | 非标准原生 Codex exe |
| CODEX_BRIDGE_CLAUDE_BIN | 非标准原生 Claude exe |
| CODEX_BRIDGE_PYTHON_BIN | 非标准 Python 3 exe |
| CODEX_QUEUE_MCP_CONFIG | MCP 进程读取的运行 settings 文件；安装器自动设置 |

显式 CLI 路径参数优先于环境变量。手动保存的依赖路径会继续沿用；需要改回其他位置时用 configure 指定新路径。完整安装、备份和恢复流程见 [README](../README.md)。
