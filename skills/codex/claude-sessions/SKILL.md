---
name: claude-sessions
description: "通过 claude-terminal MCP 列出本机在线 Claude Code 终端的会话 ID、名称、项目和 PID；用户询问 Claude 会话 ID 或有哪些在线终端时使用。"
---

# 在线 Claude 会话

调用 `claude_terminal_list`（宿主延迟加载时先发现该工具），将结果整理为 sessionId、终端名称、项目 cwd、PID 和启动时间。保留完整 sessionId，方便用户复制到 `$to-claude --session UUID 任务内容`。

没有在线会话时如实说明，可提示用户打开 Claude Code 或用 to-claude 新建。工具不可用时说明需要安装/重启 claude-terminal MCP。本技能只查询列表，不创建窗口、发送任务或替用户挑选接收端。
