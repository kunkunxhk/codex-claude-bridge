import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import TOML from "@iarna/toml";
import { prepareSkills, restoreSkills } from "./skills.mjs";

const own = (value, key) => Object.hasOwn(value || {}, key);
const parseJson = text => text.trim() ? JSON.parse(text) : {};
const parseToml = text => TOML.parse(text);
const entry = (value, group, key) => own(value[group], key) ? value[group][key] : null;
export function patchClaude(text, replacement) {
  const document = parseJson(text);
  if (document.mcpServers && (typeof document.mcpServers !== "object" || Array.isArray(document.mcpServers))) throw new Error("Invalid mcpServers object");
  document.mcpServers ||= {};
  if (replacement === null) delete document.mcpServers["codex-queue"];
  else document.mcpServers["codex-queue"] = replacement;
  return `${JSON.stringify(document, null, 2)}\n`;
}

export function patchCodex(text, replacement) {
  const before = parseToml(text), expected = structuredClone(before);
  expected.mcp_servers ||= {};
  if (replacement === null) delete expected.mcp_servers["claude-terminal"];
  else expected.mcp_servers["claude-terminal"] = replacement;
  if (isDeepStrictEqual(entry(before, "mcp_servers", "claude-terminal"), replacement)) return text;
  // Edit only this table and its subtables. Semantic comparison below rejects
  // inline/multiline/ambiguous forms rather than damaging unrelated TOML.
  let removing = false;
  const lines = text.split(/\r?\n/).filter(line => {
    if (/^\s*\[/.test(line)) removing = /^\s*\[\s*(?:mcp_servers|"mcp_servers"|'mcp_servers')\s*\.\s*(?:claude-terminal|"claude-terminal"|'claude-terminal')\s*(?:\.|\])/.test(line);
    // Keep standalone comments even at the boundary after the managed table.
    return !removing || /^\s*#/.test(line);
  });
  let output = lines.join("\n").trimEnd() + "\n";
  if (replacement !== null) output += `\n${TOML.stringify({ mcp_servers: { "claude-terminal": replacement } })}`;
  const actual = parseToml(output);
  // An absent empty root table and an empty root table are equivalent here.
  for (const value of [actual, expected]) if (value.mcp_servers && !Object.keys(value.mcp_servers).length) delete value.mcp_servers;
  if (!isDeepStrictEqual(actual, expected)) throw new Error("Unsupported Codex TOML layout: refusing to change unrelated settings");
  return output;
}

async function read(file) { return fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; }); }
async function atomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function replaceIfUnchanged(file, before, after) {
  if (await read(file) !== before) throw new Error(`Configuration changed during operation: ${file}`);
  if (before === after) return;
  if (after === null) await fs.rm(file, { force: true });
  else await atomic(file, after);
}

async function locked(options, run) {
  await fs.mkdir(options.stateDir, { recursive: true });
  const lock = path.join(options.stateDir, "install.lock");
  let handle;
  try { handle = await fs.open(lock, "wx"); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Another configuration operation is active. If it crashed, inspect and remove ${lock}`); throw error; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await run(); }
  finally { await handle.close(); await fs.rm(lock, { force: true }); }
}

function registration(options) {
  const env = { CODEX_QUEUE_MCP_CONFIG: path.join(options.stateDir, "settings.json") };
  // Do not set CLAUDE_CONFIG_DIR for a default installation: Claude uses a
  // different global JSON location when that environment variable is present.
  if (options.claudeConfigDirOverride) env.CLAUDE_CONFIG_DIR = options.claudeHome;
  return {
    claude: { type: "stdio", command: options.nodeBin, args: [path.join(options.sourceRoot, "src", "server.mjs")], env },
    codex: { command: options.nodeBin, args: [path.join(options.sourceRoot, "src", "claude-server.mjs")], env, enabled: true },
  };
}

async function transaction(options, before, after, manifest) {
  const files = { claude: options.claudeConfig, codex: options.codexConfig };
  if (options.settingsText !== undefined) {
    files.settings = path.join(options.stateDir, "settings.json");
    before.settings = own(options, "expectedSettingsText") ? options.expectedSettingsText : await read(files.settings);
    after.settings = options.settingsText;
  }
  for (const [index, change] of (options.fileChanges || []).entries()) {
    const key = `skill${index}`;
    files[key] = change.file;
    before[key] = change.before;
    after[key] = change.after;
  }
  const keys = Object.keys(files);
  const backupDir = path.join(options.stateDir, "backups", `${Date.now()}-${randomUUID()}`);
  await fs.mkdir(backupDir, { recursive: true });
  for (const key of keys) if (before[key] !== null) await fs.writeFile(path.join(backupDir, key === "codex" ? "codex.toml" : `${key}.${key.startsWith("skill") ? "txt" : "json"}`), before[key], { mode: 0o600 });
  const journal = { files, before, after };
  const journalFile = path.join(options.stateDir, "pending-transaction.json");
  if (await read(journalFile) !== null) throw new Error(`Unfinished transaction: inspect ${journalFile} and backups before retrying`);
  await atomic(journalFile, JSON.stringify(journal, null, 2));
  const written = [];
  try {
    for (const key of keys) {
      await replaceIfUnchanged(journal.files[key], before[key], after[key]);
      written.push(key);
    }
    await atomic(path.join(options.stateDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  } catch (error) {
    let rollbackOk = true;
    for (const key of written.reverse()) {
      try {
        if (await read(journal.files[key]) !== after[key]) throw new Error("Concurrent edit during rollback");
        if (before[key] === null) await fs.rm(journal.files[key]);
        else await atomic(journal.files[key], before[key]);
      } catch { rollbackOk = false; }
    }
    if (rollbackOk) await fs.rm(journalFile, { force: true });
    throw new Error(`${error.message}; ${rollbackOk ? "configuration rolled back" : `manual recovery required: ${journalFile}`}`);
  }
  // The manifest rename is the commit point. Failure to remove the recovery
  // journal must not roll back files while leaving a committed manifest.
  const cleanupWarning = await fs.rm(journalFile).then(() => null, () => `Configuration committed; journal cleanup failed. Inspect ${journalFile} before the next configure.`);
  return { backupDir, ...(cleanupWarning ? { warning: cleanupWarning } : {}) };
}

export async function install(options) {
  return locked(options, async () => {
    if (own(options, "expectedSettingsText") && await read(path.join(options.stateDir, "settings.json")) !== options.expectedSettingsText) throw new Error("Runtime settings changed while configuration was prepared; retry after reviewing the change");
    const previous = await read(path.join(options.stateDir, "manifest.json")).then(text => text ? JSON.parse(text) : null);
    if (previous?.active && (previous.claudeConfig !== options.claudeConfig || previous.codexConfig !== options.codexConfig)) throw new Error("Active installation uses different configuration files; uninstall it first");
    const before = { claude: await read(options.claudeConfig), codex: await read(options.codexConfig) };
    const current = { claude: entry(parseJson(before.claude || ""), "mcpServers", "codex-queue"), codex: entry(parseToml(before.codex || ""), "mcp_servers", "claude-terminal") };
    if (previous?.active && (!isDeepStrictEqual(current.claude, previous.installed.claude) || !isDeepStrictEqual(current.codex, previous.installed.codex))) throw new Error("Managed configuration changed since installation; conflict, refusing to overwrite");
    const installed = registration(options);
    const skills = await prepareSkills(options, previous?.active ? previous.skills : []);
    const after = { claude: patchClaude(before.claude || "", installed.claude), codex: patchCodex(before.codex || "", installed.codex) };
    const manifest = { version: 1, active: true, sourceRoot: options.sourceRoot, claudeConfig: options.claudeConfig, codexConfig: options.codexConfig, previous: previous?.active ? previous.previous : current, installed, skills: skills.records };
    const shortcuts = [...new Set(skills.records.map(item => `${item.host}:${item.name}`))];
    if (options.dryRun) return { dryRun: true, files: [options.claudeConfig, options.codexConfig, ...skills.changes.map(item => item.file)], installed, shortcuts };
    return { active: true, shortcuts, ...await transaction({ ...options, fileChanges: skills.changes }, before, after, manifest) };
  });
}

export async function uninstall(options) {
  return locked(options, async () => {
    const manifestFile = path.join(options.stateDir, "manifest.json");
    const manifest = await read(manifestFile).then(text => text ? JSON.parse(text) : null);
    if (!manifest?.active) return { active: false, message: "No active installation" };
    const targets = { ...options, claudeConfig: manifest.claudeConfig, codexConfig: manifest.codexConfig };
    const before = { claude: await read(targets.claudeConfig), codex: await read(targets.codexConfig) };
    const current = { claude: entry(parseJson(before.claude || ""), "mcpServers", "codex-queue"), codex: entry(parseToml(before.codex || ""), "mcp_servers", "claude-terminal") };
    if (!isDeepStrictEqual(current, manifest.installed)) throw new Error("Managed configuration changed: uninstall conflict; user edits preserved");
    const skillChanges = await restoreSkills(manifest.skills);
    const after = { claude: patchClaude(before.claude || "", manifest.previous.claude), codex: patchCodex(before.codex || "", manifest.previous.codex) };
    if (options.dryRun) return { dryRun: true, files: [targets.claudeConfig, targets.codexConfig, ...skillChanges.map(item => item.file)] };
    return { active: false, ...await transaction({ ...targets, fileChanges: skillChanges }, before, after, { ...manifest, active: false }) };
  });
}
