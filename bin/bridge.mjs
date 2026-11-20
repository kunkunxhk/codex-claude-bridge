#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultPaths, findDependencies, sourceRoot } from "../src/runtime.mjs";
import { install, uninstall } from "../src/lifecycle.mjs";
import { smoke } from "../src/smoke.mjs";
import { liveTest } from "../src/live-check.mjs";

const definitions = new Map([
  ["--state-dir", "stateDir"], ["--codex-home", "codexHome"], ["--claude-home", "claudeHome"],
  ["--codex-config", "codexConfig"], ["--claude-config", "claudeConfig"],
  ["--codex-bin", "codexBin"], ["--claude-bin", "claudeBin"], ["--python-bin", "pythonBin"],
  ["--claude-session", "claudeSession"], ["--codex-thread", "codexThread"],
]);

async function main() {
  if (process.platform !== "win32") throw new Error("This release supports Windows only");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Install Node.js 22 or newer");
  const [command = "help", ...args] = process.argv.slice(2), flags = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--dry-run", "--json", "--live"].includes(arg)) { flags[arg.slice(2)] = true; continue; }
    const key = definitions.get(arg);
    if (!key || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${arg}`);
    flags[key] = ["claudeSession", "codexThread"].includes(key) ? args[++i] : path.resolve(args[++i]);
  }
  if (["help", "--help", "-h"].includes(command)) {
    console.log("Usage: node bin/bridge.mjs install|configure|doctor|test|uninstall [--dry-run] [--json]\nPath overrides: --state-dir --codex-home --claude-home --codex-config --claude-config --codex-bin --claude-bin --python-bin\nDouble-click install.cmd for installation. No account login or model task is performed automatically.");
    return;
  }
  const options = { ...defaultPaths(), ...flags, sourceRoot, nodeBin: process.execPath, dryRun: !!flags["dry-run"] };
  if (flags.codexHome && !flags.codexConfig) options.codexConfig = path.join(flags.codexHome, "config.toml");
  if (flags.claudeHome && !flags.claudeConfig) options.claudeConfig = path.join(flags.claudeHome, ".claude.json");
  if (command === "uninstall") {
    console.log(JSON.stringify({ ...await uninstall(options), notice: "Uninstall preserves receipts, backups, chat history, authentication and this source folder." }, null, 2));
    return;
  }
  if (!["install", "configure", "doctor", "test"].includes(command)) throw new Error(`Unknown command: ${command}`);
  const configFile = path.join(options.stateDir, "settings.json");
  const previousText = await fs.readFile(configFile, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const previous = previousText ? JSON.parse(previousText) : {};
  const dependencyOverrides = { ...previous.dependencyOverrides, ...Object.fromEntries(["codexBin", "claudeBin", "pythonBin"].filter(key => flags[key]).map(key => [key, flags[key]])) };
  const dependencies = await findDependencies(dependencyOverrides);
  const runtime = { ...options, ...dependencies, threadPolicy: "any", defaultCwdSource: "caller", openInApp: true, sessionsRoot: path.join(options.codexHome, "sessions"), dataDir: path.join(options.stateDir, "receipts", "codex"), claudeDataDir: path.join(options.stateDir, "receipts", "claude") };
  // Saved user overrides survive a subsequent double-click with no flags.
  for (const key of ["codexHome", "claudeHome", "codexConfig", "claudeConfig"]) if (previous[key] && !flags[key] && !flags[key === "codexConfig" ? "codexHome" : key === "claudeConfig" ? "claudeHome" : key]) runtime[key] = previous[key];
  runtime.sessionsRoot = path.join(runtime.codexHome, "sessions");
  runtime.dependencyOverrides = dependencyOverrides;
  runtime.claudeConfigDirOverride = !!flags.claudeHome || !!process.env.CLAUDE_CONFIG_DIR || !!previous.claudeConfigDirOverride;
  Object.assign(options, { claudeHome: runtime.claudeHome, claudeConfigDirOverride: runtime.claudeConfigDirOverride, codexConfig: runtime.codexConfig, claudeConfig: runtime.claudeConfig });
  if (command === "doctor") {
    const pathsExist = {};
    for (const [key, file] of [["codexSessions", runtime.sessionsRoot], ["claudeSessions", path.join(runtime.claudeHome, "sessions")], ["claudeConfig", runtime.claudeConfig], ["codexConfig", runtime.codexConfig]]) pathsExist[key] = await fs.access(file).then(() => true, () => false);
    console.log(JSON.stringify({ ...dependencies, stateDir: options.stateDir, configFiles: { claude: runtime.claudeConfig, codex: runtime.codexConfig }, pathsExist, loginVerified: false, desktopRunningVerified: false, modelExecutionVerified: false }, null, 2));
    if (!dependencies.ready) process.exitCode = 1;
    return;
  }
  if (!dependencies.ready) throw new Error(`${dependencies.diagnostics.join("\n")}\nInstall Node.js >=22, Codex Desktop (with queue support), Claude Code CLI and Python 3. See README.md for official download links.`);
  if (command === "test") {
    const result = flags.live
      ? await liveTest({ sourceRoot, configFile, claudeSession: flags.claudeSession, codexThread: flags.codexThread })
      : await smoke({ sourceRoot, configFile });
    console.log(JSON.stringify(result, null, 2));
    if (flags.live && Object.values(result).some(value => typeof value === "object" && !value.passed)) process.exitCode = 1;
    return;
  }
  const plan = await install({ ...options, dryRun: true });
  if (options.dryRun) { console.log(JSON.stringify({ ...plan, dependencies }, null, 2)); return; }
  await fs.mkdir(options.stateDir, { recursive: true });
  const temporary = `${configFile}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(runtime, null, 2), { flag: "wx", mode: 0o600 });
  // Validate the actual child-process protocol before changing either client config.
  try { await smoke({ sourceRoot, configFile: temporary }); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
  // Settings and registrations share the same lifecycle lock and rollback journal.
  let result;
  try { result = await install({ ...options, expectedSettingsText: previousText, settingsText: JSON.stringify(runtime, null, 2) }); }
  finally { await fs.rm(temporary, { force: true }); }
  console.log(JSON.stringify({ ...result, dependencies, configFile, nextAction: "Restart Claude Code and Codex Desktop to load the new MCP registrations. Run test.cmd for a read-only connection check." }, null, 2));
}

main().catch(error => { console.error(`ERROR: ${error.message}`); process.exitCode = 1; });
