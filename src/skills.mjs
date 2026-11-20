import fs from "node:fs/promises";
import path from "node:path";

const templates = [
  { host: "claude", name: "to-codex", files: ["SKILL.md"] },
  { host: "codex", name: "to-claude", files: ["SKILL.md", "agents/openai.yaml"] },
  { host: "codex", name: "claude-sessions", files: ["SKILL.md", "agents/openai.yaml"] },
];
const read = file => fs.readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
const identity = file => process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);

async function assertNoLinks(file) {
  let current = path.resolve(file);
  while (true) {
    const info = await fs.lstat(current).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (info?.isSymbolicLink()) throw new Error(`Skill path contains a filesystem link: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export async function prepareSkills(options, previous = []) {
  const homes = {
    claude: options.claudeHome || path.join(path.dirname(options.claudeConfig), ".claude"),
    codex: options.codexHome || path.dirname(options.codexConfig),
  };
  const records = [], changes = [];
  for (const template of templates) {
    for (const relative of template.files) {
      const source = path.join(options.sourceRoot, "skills", template.host, template.name, relative);
      const file = path.join(homes[template.host], "skills", template.name, relative);
      await assertNoLinks(file);
      const installed = await fs.readFile(source, "utf8"), current = await read(file);
      const old = previous.find(item => identity(item.path) === identity(file));
      if (old ? current !== old.installed : current !== null && current !== installed) throw new Error(`Skill conflict: ${file} was created or changed outside this installation`);
      records.push({ host: template.host, name: template.name, path: file, previous: old ? old.previous : current, installed });
      changes.push({ file, before: current, after: installed });
    }
  }
  // Restore files retired by a future release instead of leaving stale shortcuts.
  for (const old of previous.filter(item => !records.some(record => identity(record.path) === identity(item.path)))) {
    await assertNoLinks(old.path);
    const current = await read(old.path);
    if (current !== old.installed) throw new Error(`Skill conflict: ${old.path} was changed since installation`);
    changes.push({ file: old.path, before: current, after: old.previous });
  }
  return { records, changes };
}

export async function restoreSkills(records = []) {
  const changes = [];
  for (const record of records) {
    await assertNoLinks(record.path);
    const current = await read(record.path);
    if (current !== record.installed) throw new Error(`Skill uninstall conflict: ${record.path} was changed; user edits preserved`);
    changes.push({ file: record.path, before: current, after: record.previous });
  }
  return changes;
}

export async function inspectSkills(stateDir) {
  const manifest = await read(path.join(stateDir, "manifest.json")).then(text => text ? JSON.parse(text) : null);
  if (!manifest?.active || !manifest.skills?.length) return { installed: false, valid: false, shortcuts: [] };
  const shortcuts = [];
  for (const template of templates) {
    const records = manifest.skills.filter(item => item.host === template.host && item.name === template.name);
    const valid = records.length === template.files.length && (await Promise.all(records.map(async record => await read(record.path) === record.installed))).every(Boolean);
    shortcuts.push({ host: template.host, name: template.name, valid, files: records.map(item => item.path) });
  }
  return { installed: true, valid: shortcuts.every(item => item.valid), shortcuts };
}
