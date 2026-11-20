import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const execute = promisify(execFile);

// This short-lived server only creates an empty persistent thread. It never runs a model turn.
// It must exit (and release its writer) before the Desktop app opens that thread.
export async function createDesktopThread(config, cwd, onCreated = async () => {}) {
  const child = spawn(config.codexBin, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, CODEX_HOME: config.codexHome },
  });
  const pending = new Map();
  let sequence = 0;
  let stopped = false;
  const fail = error => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const closed = new Promise(resolve => child.once("close", () => { stopped = true; fail(new Error("Creation server closed")); resolve(); }));
  child.once("error", error => fail(error));
  child.stderr.on("data", () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let response;
    try { response = JSON.parse(line); } catch { return; }
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(`Codex creation RPC failed: ${response.error.message}`));
    else request.resolve(response.result);
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex creation RPC timed out: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n", error => {
      if (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  });
  // A closed pipe is reported by the request callback, not an unhandled stream error.
  child.stdin.on("error", fail);
  let threadId;
  try {
    await call("initialize", { clientInfo: { name: "codex-claude-bridge", version: "1.1.0" } });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    const response = await call("thread/start", { cwd, ephemeral: false, approvalPolicy: "on-request", sandbox: "workspace-write" });
    threadId = response.thread?.id;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId ?? "")) throw new Error("Creation server returned no valid thread ID");
    await onCreated(threadId);
    // Codex defers persistence for an empty chat. Materialize it without invoking a model,
    // so Desktop can reopen it after this creator exits and releases its writer.
    await call("thread/inject_items", { threadId, items: [{
      type: "message", role: "user", content: [{ type: "input_text", text: "[codex-queue-mcp 会话初始化：等待后续队列消息。]" }],
    }] });
    return threadId;
  } finally {
    child.stdin.end();
    await Promise.race([closed, delay(5000)]);
    if (!stopped) { child.kill(); await Promise.race([closed, delay(5000)]); }
    lines.close();
    if (!stopped) throw new Error("Creation server has not exited; Desktop handoff was not attempted");
  }
}

export async function openDesktopThread(threadId) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(threadId)) throw new Error("Invalid Desktop thread ID");
  const url = `codex://threads/${threadId}`;
  if (process.platform === "win32") {
    // The interpolated value is restricted to UUID characters above, never arbitrary shell text.
    await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process -FilePath '${url}'`], { windowsHide: true, timeout: 10000 });
  } else {
    await execute(process.platform === "darwin" ? "open" : "xdg-open", [url], { timeout: 10000 });
  }
}
