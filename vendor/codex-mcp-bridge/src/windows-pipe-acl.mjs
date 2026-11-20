import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { IS_WINDOWS } from "./platform.mjs";
import path from "node:path";

const execFile = promisify(execFileCallback);
const systemRoot = process.env.SystemRoot || process.env.WINDIR;
const powershell = systemRoot ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";

export function bridgePipeName(socketPath) {
  const prefix = "\\\\.\\pipe\\";
  if (typeof socketPath !== "string" || !socketPath.startsWith(prefix)) throw new Error("A Windows ACL may only protect a named pipe");
  return socketPath.slice(prefix.length);
}

export async function protectCurrentUserPipe(socketPath, { pid = process.pid, run = execFile } = {}) {
  if (!IS_WINDOWS) return { skipped: true };
  const name = bridgePipeName(socketPath);
  const script = fileURLToPath(new URL("./windows-pipe-acl.ps1", import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "psmodulepath"));
  if (systemRoot) env.PSModulePath = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "Modules");
  const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-File", script, "-PipeName", name, "-ServerPid", String(pid)], { env, windowsHide: true, timeout: 15000 });
  let result;
  try { result = JSON.parse(stdout.trim()); } catch { throw new Error("Windows pipe ACL helper returned invalid readback"); }
  if (result?.serverMatches !== true || result?.serverUserMatches !== true || result?.ownerMatches !== true || result?.protected !== true || result?.aceCount !== 1
      || result?.rights !== 2032031 || result?.anonymousDenied !== true || result?.readError !== 5 || result?.duplexError !== 5) {
    throw new Error("Windows pipe ACL readback did not prove exact current-user FullControl and anonymous denial");
  }
  return result;
}
