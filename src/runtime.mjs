import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const sourceRoot = path.resolve(import.meta.dirname, "..");
export function defaultPaths(env = process.env, home = os.homedir()) {
  const claudeHome = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const codexHome = env.CODEX_HOME || path.join(home, ".codex");
  const stateDir = env.CODEX_CLAUDE_BRIDGE_HOME || path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "CodexClaudeBridge");
  return { stateDir, codexHome, claudeHome, codexConfig: path.join(codexHome, "config.toml"), claudeConfig: env.CLAUDE_CONFIG_DIR ? path.join(claudeHome, ".claude.json") : path.join(home, ".claude.json") };
}

async function exists(file) { return !!file && await fs.stat(file).then(s => s.isFile(), () => false); }
async function children(directory) { return await fs.readdir(directory).catch(() => []); }
async function probe(file, args) {
  const result = await execute(file, args, { windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 });
  return `${result.stdout}\n${result.stderr}`.trim();
}

async function candidates(env) {
  const home = os.homedir(), local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const desktop = path.join(local, "OpenAI", "Codex", "bin");
  const codex = [], claude = [path.join(home, ".local", "bin", "claude.exe")], python = [];
  // Desktop releases live in versioned directories. Probe capability instead of guessing an ID.
  const releases = await Promise.all((await children(desktop)).map(async name => ({ file: path.join(desktop, name, "codex.exe"), time: await fs.stat(path.join(desktop, name)).then(s => s.mtimeMs, () => 0) })));
  codex.push(...releases.sort((a, b) => b.time - a.time).map(item => item.file));
  for (const directory of (env.PATH || "").split(path.delimiter).filter(Boolean)) {
    codex.push(path.join(directory, "codex.exe"));
    claude.push(path.join(directory, "claude.exe"), path.join(directory, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    python.push(path.join(directory, "python.exe"));
    const openai = path.join(directory, "node_modules", "@openai");
    const vendorRoots = [path.join(openai, "codex", "vendor")];
    for (const platform of ["codex-win32-x64", "codex-win32-arm64"]) {
      vendorRoots.push(path.join(openai, platform, "vendor"), path.join(openai, "codex", "node_modules", "@openai", platform, "vendor"));
    }
    for (const vendors of vendorRoots) {
      for (const architecture of await children(vendors)) codex.push(path.join(vendors, architecture, "codex", "codex.exe"));
    }
  }
  for (const name of (await children(path.join(local, "Programs", "Python"))).sort().reverse()) python.unshift(path.join(local, "Programs", "Python", name, "python.exe"));
  return { codex, claude, python };
}

export async function findDependencies(options = {}) {
  const env = options.env || process.env, run = options.probe || probe;
  const found = options.candidates || await candidates(env);
  const output = { nodeBin: process.execPath, nodeVersion: process.versions.node, diagnostics: [] };
  for (const [kind, key, override] of [["codex", "codexBin", options.codexBin || env.CODEX_BRIDGE_CODEX_BIN], ["claude", "claudeBin", options.claudeBin || env.CODEX_BRIDGE_CLAUDE_BIN], ["python", "pythonBin", options.pythonBin || env.CODEX_BRIDGE_PYTHON_BIN]]) {
    const files = [...new Set(override ? [override] : found[kind])];
    for (const file of files) {
      if (!path.isAbsolute(file) || !await exists(file)) continue;
      try {
        const version = await run(file, ["--version"]);
        if (kind === "codex") await run(file, ["queue", "--help"]);
        if (kind === "python" && !/^Python 3\./m.test(version)) throw new Error("Python 3 is required");
        output[key] = await fs.realpath(file);
        output[`${kind}Version`] = version.split(/\r?\n/)[0];
        break;
      } catch { output.diagnostics.push(`${kind}: rejected ${file} (version/capability probe failed)`); }
    }
    if (!output[key]) output.diagnostics.push(`${kind}: not found; install it or provide --${kind}-bin with its native .exe path`);
  }
  output.ready = Number(process.versions.node.split(".")[0]) >= 22 && !!output.codexBin && !!output.claudeBin && !!output.pythonBin;
  return output;
}

export async function loadRuntimeConfig() {
  const defaults = defaultPaths();
  const configFile = process.env.CODEX_QUEUE_MCP_CONFIG || path.join(defaults.stateDir, "settings.json");
  const saved = await fs.readFile(configFile, "utf8").then(JSON.parse, error => {
    if (error.code !== "ENOENT") throw error;
    return {};
  });
  const needsDiscovery = !(await Promise.all([saved.codexBin, saved.claudeBin, saved.pythonBin].map(exists))).every(Boolean);
  const dependencies = needsDiscovery ? await findDependencies(saved.dependencyOverrides || {}) : saved;
  if (needsDiscovery && !dependencies.ready) throw new Error(`Runtime dependencies unavailable. Run doctor.cmd/configure.cmd. ${dependencies.diagnostics.join("; ")}`);
  const codexHome = saved.codexHome || defaults.codexHome;
  return {
    ...defaults, ...saved, ...dependencies, configFile, codexHome,
    sessionsRoot: saved.sessionsRoot || path.join(codexHome, "sessions"),
    dataDir: saved.dataDir || path.join(defaults.stateDir, "receipts", "codex"),
    claudeDataDir: saved.claudeDataDir || path.join(defaults.stateDir, "receipts", "claude"),
    threadPolicy: saved.threadPolicy || "any", defaultCwdSource: "caller", openInApp: saved.openInApp !== false,
  };
}
