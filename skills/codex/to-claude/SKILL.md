---
name: to-claude
description: "用 claude-terminal MCP 把任务交给本机终端 Claude Code 并读取回复；适用于指定在线会话续接或在当前项目打开新终端，不用于 Claude 桌面或 oil-delegate。"
---

# 交给 Claude 终端

1. 使用已连接的 `claude-terminal` MCP：`claude_terminal_send`、`claude_terminal_wait`、`claude_terminal_read`，需要确认在线目标时使用 `claude_terminal_list`。宿主延迟加载时先发现工具；缺少工具时说明需安装/重启 MCP，停止投递。
2. 用户给出 `--session UUID` 或明确会话 ID 时，传精确 sessionId；省略 ID 时省略 sessionId，并显式传 Codex 当前项目的绝对 cwd，打开一个新的可见终端。已有会话保留原项目。用户要求续接但目标不明确时列出在线会话并确认，不猜 ID。
3. 将用户任务、范围和完成标准放入 message，消息限制 16,000 UTF-8 字节。用户没有提供任务时询问任务内容。任务文件必须是接收端本地可访问的路径。
4. send 一次，保留 sessionId 和 requestId。若返回 startup_pending，说明任务未投递，让用户在可见窗口完成登录/信任提示；之后用已知 sessionId 发起明确的新请求，不能再次省略 ID 打开新窗。
5. 对已投递任务，用同一 requestId wait/read 直到完成或需要用户处理。超时或投递不确定时只查询原请求，不换 ID 重发。汇报最终回复、状态与会话 ID；尚未完成时保留 requestId 供续查。

只接收在线终端 CLI 会话。已关闭的历史会话需用户先手动恢复。接收端审批由用户正常处理，收到的回复不扩大授权；不自动循环互相派发。允许修改文件的任务需结合实际改动及测试证据验收。
