import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { install, uninstall } from "../src/lifecycle.mjs";
import { sourceRoot } from "../src/runtime.mjs";
import { inspectSkills } from "../src/skills.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-skills-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { stateDir: path.join(root, "state"), claudeHome: path.join(root, "claude"), codexHome: path.join(root, "codex"), claudeConfig: path.join(root, "claude.json"), codexConfig: path.join(root, "codex.toml"), sourceRoot, nodeBin: process.execPath };
}

test("install adds host-specific shortcuts and uninstall removes only its managed files", async t => {
  const options = await fixture(t);
  await install(options);
  const claudeSkill = path.join(options.claudeHome, "skills", "to-codex", "SKILL.md");
  const codexSkill = path.join(options.codexHome, "skills", "to-claude", "SKILL.md");
  assert.match(await fs.readFile(claudeSkill, "utf8"), /codex_queue_send/);
  assert.match(await fs.readFile(codexSkill, "utf8"), /claude_terminal_send/);
  assert.match(await fs.readFile(path.join(options.codexHome, "skills", "claude-sessions", "SKILL.md"), "utf8"), /claude_terminal_list/);
  await install(options);
  const userFile = path.join(path.dirname(codexSkill), "notes.txt");
  await fs.writeFile(userFile, "user notes");
  await uninstall(options);
  assert.equal(await fs.readFile(userFile, "utf8"), "user notes");
  assert.equal(await fs.access(codexSkill).then(() => true, () => false), false);
  assert.equal(await fs.access(claudeSkill).then(() => true, () => false), false);
});

test("same-named unrelated skills cause a conflict before client config changes", async t => {
  const options = await fixture(t);
  const file = path.join(options.claudeHome, "skills", "to-codex", "SKILL.md");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "my existing skill");
  await assert.rejects(() => install(options), /skill.*conflict/i);
  assert.equal(await fs.readFile(file, "utf8"), "my existing skill");
  assert.equal(await fs.access(options.claudeConfig).then(() => true, () => false), false);
});

test("uninstall refuses to erase a locally edited shortcut", async t => {
  const options = await fixture(t);
  await install(options);
  const file = path.join(options.codexHome, "skills", "to-claude", "SKILL.md");
  await fs.appendFile(file, "\nuser change\n");
  await assert.rejects(() => uninstall(options), /skill.*conflict/i);
  assert.match(await fs.readFile(file, "utf8"), /user change/);
  assert.equal(JSON.parse(await fs.readFile(path.join(options.stateDir, "manifest.json"))).active, true);
});

test("upgrading an active pre-skills manifest adds shortcuts without losing original restore state", async t => {
  const options = await fixture(t);
  await fs.writeFile(options.claudeConfig, JSON.stringify({ mcpServers: { "codex-queue": { command: "original" } } }));
  await install(options);
  const file = path.join(options.stateDir, "manifest.json");
  const old = JSON.parse(await fs.readFile(file));
  for (const record of old.skills) await fs.rm(record.path);
  delete old.skills;
  await fs.writeFile(file, JSON.stringify(old));
  await install(options);
  const updated = JSON.parse(await fs.readFile(file));
  assert.equal(updated.skills.length, 5);
  assert.equal(updated.previous.claude.command, "original");
  await uninstall(options);
  assert.equal(JSON.parse(await fs.readFile(options.claudeConfig)).mcpServers["codex-queue"].command, "original");
});

test("manifest commit failure rolls back all newly installed skill files", { skip: process.platform !== "win32" }, async t => {
  const options = await fixture(t);
  await fs.mkdir(options.stateDir);
  const file = path.join(options.stateDir, "manifest.json");
  await fs.writeFile(file, '{}');
  await fs.chmod(file, 0o444);
  t.after(() => fs.chmod(file, 0o666).catch(() => {}));
  await assert.rejects(() => install(options), /rolled back/);
  assert.equal(await fs.access(path.join(options.claudeHome, "skills", "to-codex", "SKILL.md")).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(options.codexHome, "skills", "to-claude", "SKILL.md")).then(() => true, () => false), false);
});

test("changing only Windows home path casing neither retires installed skills nor loses restore state", { skip: process.platform !== "win32" }, async t => {
  const options = await fixture(t);
  await install(options);
  await install({ ...options, codexHome: path.join(path.dirname(options.codexHome), "CODEX") });
  assert.equal((await inspectSkills(options.stateDir)).valid, true);
  const manifest = JSON.parse(await fs.readFile(path.join(options.stateDir, "manifest.json")));
  assert.equal(manifest.skills.every(record => record.previous === null), true);
  await uninstall(options);
});
