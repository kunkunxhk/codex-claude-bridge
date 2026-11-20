import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sourceRoot, findDependencies } from "../src/runtime.mjs";
import { distributionFiles } from "../src/distribution.mjs";

const execute = promisify(execFile);
const dependencies = await findDependencies();
if (!dependencies.pythonBin) throw new Error("Python 3 is required to build the ZIP");
const files = await distributionFiles(sourceRoot);
const required = ["README.md", "LICENSE", "package-lock.json", "install.cmd", "src/server.mjs", "src/claude-server.mjs", "vendor/codex-mcp-bridge/LICENSE"];
for (const file of required) if (!files.includes(file)) throw new Error(`Missing distribution file: ${file}`);
const home = os.homedir(), sensitiveStrings = [home, home.replaceAll("\\", "/"), home.replaceAll("\\", "\\\\")].filter(value => value.length > 5);
for (const file of files) {
  if (/(^|\/)(?:node_modules|receipts|claude-receipts|sessions|backups|\.git)(\/|$)|(^|\/)(?:settings|manifest)\.json$|\.log$|\.jsonl$/i.test(file)) throw new Error(`Private artifact in distribution: ${file}`);
  const content = await fs.readFile(path.join(sourceRoot, file), "utf8");
  for (const value of sensitiveStrings) if (content.toLowerCase().includes(value.toLowerCase())) throw new Error(`Local user path found in ${file}`);
}
const pkg = JSON.parse(await fs.readFile(path.join(sourceRoot, "package.json")));
const dist = path.join(sourceRoot, "dist");
await fs.mkdir(dist, { recursive: true });
const target = path.join(dist, `codex-claude-bridge-${pkg.version}-windows.zip`);
const manifest = path.join(os.tmpdir(), `bridge-files-${randomUUID()}.json`);
try {
  await fs.writeFile(manifest, JSON.stringify(files), { flag: "wx" });
  await execute(dependencies.pythonBin, [path.join(sourceRoot, "bin", "archive.py"), sourceRoot, target, manifest], { timeout: 30000, windowsHide: true });
} finally { await fs.rm(manifest, { force: true }); }
const checksum = createHash("sha256").update(await fs.readFile(target)).digest("hex");
await fs.writeFile(`${target}.sha256`, `${checksum}  ${path.basename(target)}\n`);
console.log(JSON.stringify({ target, files: files.length, bytes: (await fs.stat(target)).size, sha256: checksum }, null, 2));
