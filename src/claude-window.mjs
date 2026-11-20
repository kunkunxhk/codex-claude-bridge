import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const launcher = fileURLToPath(new URL("./launch-claude-window.py", import.meta.url));

export async function launchClaudeWindow({ executable, pythonBin, dataDir, sessionId, cwd, name }) {
  if (process.platform !== "win32") throw new Error("Visible Claude launch currently supports Windows only");
  if (!path.isAbsolute(executable ?? "") || !executable.toLowerCase().endsWith(".exe")) throw new Error("Configure the native Claude .exe absolute path");
  await fs.access(executable);
  const folder = path.join(dataDir, "launches");
  await fs.mkdir(folder, { recursive: true });
  const plan = path.join(folder, `${sessionId}.json`);
  await fs.writeFile(plan, JSON.stringify({ executable, sessionId, cwd, name }), { flag: "wx", mode: 0o600 });
  // CREATE_NEW_CONSOLE supplies real terminal handles; no shell or task text is executed here.
  const { stdout } = await execute(pythonBin, [launcher, plan], {
    windowsHide: true, timeout: 15000, maxBuffer: 65536,
  });
  return JSON.parse(stdout.trim());
}
