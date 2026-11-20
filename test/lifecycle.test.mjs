import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { patchClaude, patchCodex, install, uninstall } from "../src/lifecycle.mjs";
import { findDependencies, defaultPaths } from "../src/runtime.mjs";

test("default paths derive from supplied user environment", () => {
  const paths = defaultPaths({ LOCALAPPDATA: path.resolve("local"), CODEX_HOME: path.resolve("custom-codex"), CLAUDE_CONFIG_DIR: path.resolve("custom-claude") }, path.resolve("home"));
  assert.equal(paths.codexHome, path.resolve("custom-codex"));
  assert.equal(paths.claudeHome, path.resolve("custom-claude"));
  assert.equal(paths.stateDir, path.resolve("local", "CodexClaudeBridge"));
});

test("discovery validates capabilities and prefers working desktop Codex over an old CLI", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = path.join(root, "old.exe"), current = path.join(root, "new.exe"), claude = path.join(root, "claude.exe"), python = path.join(root, "python.exe");
  for (const file of [old, current, claude, python]) await fs.writeFile(file, "fixture");
  const probe = async (file, args) => {
    if (file === old && args[0] === "queue") throw new Error("unsupported");
    return file === current ? "codex 0.169.0\nUsage: codex queue" : file === python ? "Python 3.13.0" : "2.1.328";
  };
  const result = await findDependencies({ candidates: { codex: [old, current], claude: [claude], python: [python] }, probe });
  assert.equal(result.codexBin, current);
  assert.equal(result.claudeBin, claude);
  assert.equal(result.pythonBin, python);
});

test("discovers native Codex in the npm optional Windows platform package", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-npm-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const native = path.join(root, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe");
  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.writeFile(native, "fixture");
  const result = await findDependencies({ env: { PATH: root, LOCALAPPDATA: root }, claudeBin: native, pythonBin: native, probe: async (_, args) => args[0] === "queue" ? "Usage: codex queue" : "Python 3.13.0" });
  assert.equal(result.codexBin, native);
});

test("targeted configuration preserves unrelated settings including empty arrays and comments", () => {
  const entry = { command: "node.exe", args: ["C:/bridge/src/claude-server.mjs"], enabled: true };
  const before = '# keep comment\nmodel = "user-model"\n[mcp_servers.node_repl]\nargs = []\n[mcp_servers.claude-terminal]\ncommand = "old"\nargs = ["old"]\n[mcp_servers.claude-terminal.env]\nOLD = "1"\n[mcp_servers.other]\ncommand = "other"\n';
  const after = patchCodex(before, entry);
  assert.match(after, /# keep comment/);
  assert.match(after, /args = \[\]/);
  assert.doesNotMatch(after, /OLD/);
  assert.equal(patchCodex(after, entry), after);
  const json = patchClaude('{"unrelated":true,"mcpServers":{"other":{"command":"other"}}}', { type: "stdio", command: "node", args: [] });
  assert.equal(JSON.parse(json).unrelated, true);
  assert.equal(JSON.parse(json).mcpServers.other.command, "other");
});

test("install is idempotent, uninstall restores only managed entries and protects user edits", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { stateDir: path.join(root, "state"), claudeConfig: path.join(root, "claude.json"), codexConfig: path.join(root, "codex.toml"), sourceRoot: path.resolve(import.meta.dirname, ".."), nodeBin: process.execPath };
  await fs.writeFile(options.claudeConfig, JSON.stringify({ mcpServers: { "codex-queue": { command: "old-bridge" }, other: { command: "keep" } } }));
  await fs.writeFile(options.codexConfig, 'model="keep"\n[mcp_servers.node_repl]\nargs=[]\n');
  await install(options);
  await install(options);
  await fs.appendFile(options.codexConfig, '\n# user added comment\n');
  await uninstall(options);
  assert.equal(JSON.parse(await fs.readFile(options.claudeConfig)).mcpServers["codex-queue"].command, "old-bridge");
  assert.match(await fs.readFile(options.codexConfig, "utf8"), /user added comment/);
  await install(options);
  const edited = JSON.parse(await fs.readFile(options.claudeConfig));
  edited.mcpServers["codex-queue"].command = "user-edited";
  await fs.writeFile(options.claudeConfig, JSON.stringify(edited));
  await assert.rejects(() => uninstall(options), /changed|conflict/i);
  assert.equal(JSON.parse(await fs.readFile(options.claudeConfig)).mcpServers["codex-queue"].command, "user-edited");
});

test("failed configuration commit rolls back settings and does not activate a partial installation", { skip: process.platform !== "win32" }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { stateDir: path.join(root, "state"), claudeConfig: path.join(root, "claude.json"), codexConfig: path.join(root, "codex.toml"), sourceRoot: path.resolve(import.meta.dirname, ".."), nodeBin: process.execPath, settingsText: '{"new":true}' };
  await fs.mkdir(options.stateDir);
  await fs.writeFile(options.claudeConfig, '{}');
  await fs.writeFile(options.codexConfig, 'model="original"\n');
  await fs.writeFile(path.join(options.stateDir, "settings.json"), '{"original":true}');
  // A Windows read-only manifest forces the final rename to fail after all
  // configuration writes, exercising rollback against a real filesystem error.
  const manifest = path.join(options.stateDir, "manifest.json");
  await fs.writeFile(manifest, '{}');
  await fs.chmod(manifest, 0o444);
  t.after(() => fs.chmod(manifest, 0o666).catch(() => {}));
  await assert.rejects(() => install(options), /rolled back/);
  assert.equal(await fs.readFile(options.claudeConfig, "utf8"), '{}');
  assert.equal(await fs.readFile(options.codexConfig, "utf8"), 'model="original"\n');
  assert.equal(await fs.readFile(path.join(options.stateDir, "settings.json"), "utf8"), '{"original":true}');
});

test("configuration refuses stale settings prepared before another editor's change", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-concurrent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { stateDir: path.join(root, "state"), claudeConfig: path.join(root, "claude.json"), codexConfig: path.join(root, "codex.toml"), sourceRoot: path.resolve(import.meta.dirname, ".."), nodeBin: process.execPath, expectedSettingsText: '{"old":true}', settingsText: '{"prepared":true}' };
  await fs.mkdir(options.stateDir);
  await fs.writeFile(path.join(options.stateDir, "settings.json"), '{"concurrent":true}');
  await assert.rejects(() => install(options), /settings.*changed/i);
  assert.equal(await fs.readFile(path.join(options.stateDir, "settings.json"), "utf8"), '{"concurrent":true}');
  assert.equal(await fs.access(options.claudeConfig).then(() => true, () => false), false);
});

test("journal cleanup failure keeps committed manifest and registrations consistent", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-journal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = { stateDir: path.join(root, "state"), claudeConfig: path.join(root, "claude.json"), codexConfig: path.join(root, "codex.toml"), sourceRoot: path.resolve(import.meta.dirname, ".."), nodeBin: process.execPath, settingsText: '{"installed":true}' };
  const realRemove = fs.rm;
  t.mock.method(fs, "rm", async (file, ...args) => {
    if (file === path.join(options.stateDir, "pending-transaction.json")) throw new Error("Simulated cleanup failure");
    return realRemove(file, ...args);
  });
  const result = await install(options);
  assert.match(result.warning, /committed/);
  assert.equal(JSON.parse(await fs.readFile(path.join(options.stateDir, "manifest.json"))).active, true);
  assert.equal(JSON.parse(await fs.readFile(options.claudeConfig)).mcpServers["codex-queue"].command, process.execPath);
  assert.equal(await fs.readFile(path.join(options.stateDir, "settings.json"), "utf8"), '{"installed":true}');
});
