# 常见问题与排查

## 安装后 AI 看不到工具

先运行 `doctor.cmd --json`，确认依赖可用，再运行 `test.cmd --json`。两个 MCP 都显示 connected 后，重新启动终端 Claude Code 和 Codex 桌面端。当前已经运行的宿主进程不一定会自动读取新注册。

项目需要保留在安装时的位置。移动源码后在新位置运行 configure.cmd，并重启两端。

## 检测到旧 Codex，或者找不到 queue

本项目需要原生 Codex 中的 queue 能力，仅仅 `codex --version` 能运行还不够。检测会优先查找桌面端版本并实际执行 queue --help。更新 Codex 桌面端后重新运行 configure.cmd；非标准安装可以传 `--codex-bin "X:\apps\codex.exe"`。

不要把 `.cmd` 包装器当作原生 exe。手动指定的路径会保存，旧文件已被删除时，需要指定新路径。

## Python 已安装，但还是检测不到

WindowsApps 中的 python.exe 可能只是商店占位程序。本项目会验证 Python 3 版本；使用 Python 的真实 exe，或通过 `--python-bin` 指定它。Python 负责打开具有真实控制台句柄的可见 Claude 终端，不会把任务正文作为 shell 命令执行。

## Claude 会话 ID 找不到

先用 claude_terminal_list 获取在线终端列表。历史会话关闭后不会作为在线目标；用 `claude --resume <UUID>` 恢复，再确认列表。确认桥接和 Claude 运行在同一 Windows 用户以及相同配置目录下。

错误的显式 ID 不会被悄悄替换成新会话。确实要创建新终端时，应省略 sessionId。

## 新窗口打开了，但是 startup_pending

桥接没有确认这个窗口注册完成，因此没有投递任务。查看可见终端，完成登录、目录信任或其他启动提示。随后使用返回的 sessionId 明确发送任务；不要再省略 ID，否则会要求创建另一个窗口。

## wait 超时、pending 或投递状态不确定

保留原 requestId，继续 wait/read，并查看接收端窗口是否正在执行或等待审批。不要换 requestId 重发。send/queue 成功不等于模型执行完成，doctor 依赖就绪也不等于账号已认证或有额度。

Codex 桌面端需要能加载并执行目标聊天。Claude 终端也需要正常在线。关闭接收端、接收端拒绝任务、额度不足或模型配置错误，都可能使任务无法完成。

## already has an active writer

不要同时用另一个 `codex exec resume` 去接管正在由桌面端使用的聊天。本桥对已有 Codex 聊天使用 queue；如果错误发生在其他 CLI/桥接流程中，先检查那条流程是否仍在附加 writer，不要靠不断创建新聊天掩盖问题。

## 工具调用被宿主权限策略拒绝

发送任务可能让接收端修改文件，因此属于有副作用的操作。宿主或接收端要求审批时，按其正常流程处理；本桥不修改工具标注以绕过审批，也不代替用户批准。

## 配置冲突，安装或卸载拒绝覆盖

本项目会记住自己安装的两个 MCP 项。如果你后续手动修改它们，安装/卸载会停止，保留你的更改。先对照当前配置、状态目录中的 manifest 和 backups，确认希望保留的注册，再处理冲突。不要整份覆盖 Claude/Codex 配置。

其他无关设置可以正常修改，卸载只处理本项目管理的注册。如果安装前已有旧桥接，卸载会恢复旧注册；它不保证旧桥接的程序目录仍存在。

## install.lock 或 pending-transaction.json 残留

强行结束安装进程可能留下恢复记录。先确认没有安装进程正在运行，再查看 journal 的 files/before/after 和 backups。根据当前内容恢复一致状态后处理残留记录。manifest 已提交后，如果只是清理 journal 失败，程序会返回 committed warning，不会撤销已提交配置。

这些文件可能含原配置中的敏感信息，不要直接发到 GitHub Issues。

## 回复长度与消息大小

任务上限是 16,000 UTF-8 字节，中文通常每字占多个字节。把长说明放到接收端能访问的文件，消息中给路径。Codex 回复默认不截断；设置 maxReplyChars 只限制这次读取的返回量，可不带上限重新读取原 requestId。

## 是否支持 Claude 桌面、其他 AI 或远程电脑

当前交付目标是 Windows 本地的 Codex 桌面与 Claude Code 终端。没有声称验证 Claude 桌面版配置、其他 AI CLI、跨 Windows 用户或远程机器调用。更广的上游功能不能视为本项目已支持。

## 提交问题前提供什么

提供复现步骤、Windows/Node/Python/Codex/Claude 版本、doctor/test 是否通过、错误状态和脱敏后的必要片段。不要公开任务正文、完整历史、密钥、登录信息、settings、manifest、backups 和事务日志。项目路径、会话 ID、PID 等也应按需要脱敏。
