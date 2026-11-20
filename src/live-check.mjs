import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// This opt-in check spends the recipient's normal model quota. It never chooses
// a conversation implicitly or creates an unexpected chat/window.
export async function liveTest({ sourceRoot, configFile, claudeSession, codexThread }) {
  if (!claudeSession && !codexThread) throw new Error("Live test requires an explicit Claude session ID or Codex thread ID");
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  for (const value of [claudeSession, codexThread]) if (value && !uuid.test(value)) throw new Error("Recipient ID must be an exact UUID");
  const results = {};
  for (const [kind, target, file, prefix, idKey] of [["claude", claudeSession, "claude-server.mjs", "claude_terminal", "sessionId"], ["codex", codexThread, "server.mjs", "codex_queue", "threadId"]]) {
    if (!target) continue;
    const client = new Client({ name: "bridge-live-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(sourceRoot, "src", file)], env: { ...process.env, CODEX_QUEUE_MCP_CONFIG: configFile }, stderr: "pipe" });
    const call = async (name, args) => {
      const value = await client.callTool({ name, arguments: args }, undefined, { timeout: 55000 });
      const text = value.content?.find(item => item.type === "text")?.text;
      if (value.isError) throw new Error(text || "MCP returned an error");
      return value.structuredContent || JSON.parse(text);
    };
    try {
      await client.connect(transport, { timeout: 15000 });
      const token = `BRIDGE_OK_${randomUUID().slice(0, 8)}`;
      const request = await call(`${prefix}_send`, { [idKey]: target, requestId: randomUUID(), message: `这是 MCP 连通性测试。请只回复以下文字，不要调用工具或修改任何文件：${token}` });
      let result;
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await call(`${prefix}_wait`, { requestId: request.requestId, timeoutSeconds: 35 });
        if (result.status !== "pending" && result.status !== "running" && !result.timedOut) break;
        if (result.status === "completed") break;
      }
      results[kind] = { requestId: request.requestId, [idKey]: target, status: result.status, reply: result.reply, passed: result.status === "completed" && result.reply?.includes(token) === true, nextAction: "If pending, read/wait this same requestId. Do not resend." };
    } finally { await client.close(); }
  }
  return { modelTaskSent: true, ...results };
}
