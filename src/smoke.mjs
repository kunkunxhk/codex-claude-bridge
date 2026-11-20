import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function smoke({ sourceRoot, configFile }) {
  const result = { modelTaskSent: false };
  for (const [kind, file, tool] of [["codex", "server.mjs", "codex_queue_status"], ["claude", "claude-server.mjs", "claude_terminal_list"]]) {
    const client = new Client({ name: "bridge-self-test", version: "1.0.0" });
    const env = { ...process.env };
    if (configFile) env.CODEX_QUEUE_MCP_CONFIG = configFile;
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(sourceRoot, "src", file)], env, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", chunk => { stderr = (stderr + chunk).slice(-8000); });
    try {
      await client.connect(transport, { timeout: 15000 });
      const tools = await client.listTools();
      const check = await client.callTool({ name: tool, arguments: {} }, undefined, { timeout: 15000 });
      if (check.isError) throw new Error(check.content?.find(item => item.type === "text")?.text || "Readiness tool failed");
      const content = check.structuredContent || JSON.parse(check.content.find(item => item.type === "text").text);
      result[kind] = { connected: true, tools: tools.tools.map(item => item.name), ...(kind === "claude" ? { onlineSessions: content.sessions.length } : { threadPolicy: content.threadPolicy }) };
    } catch (error) { throw new Error(`${kind} MCP test failed: ${error.message}${stderr ? `\n${stderr}` : ""}`); }
    finally { await client.close(); }
  }
  return result;
}
