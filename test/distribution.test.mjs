import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { distributionFiles } from "../src/distribution.mjs";

test("distribution is an allowlist and rejects source links", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "receipts"));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "src", "core.mjs"), "export const ok = true;");
  await fs.mkdir(path.join(root, "skills", "claude", "to-codex"), { recursive: true });
  await fs.writeFile(path.join(root, "skills", "claude", "to-codex", "SKILL.md"), "skill fixture");
  await fs.writeFile(path.join(root, "settings.json"), "private");
  await fs.writeFile(path.join(root, "receipts", "secret.json"), "private");
  await fs.writeFile(path.join(root, "node_modules", "secret.json"), "private");
  const files = await distributionFiles(root);
  assert.deepEqual(files, ["skills/claude/to-codex/SKILL.md", "src/core.mjs"]);
  await fs.symlink(path.join(root, "receipts"), path.join(root, "src", "linked"), "junction");
  await assert.rejects(() => distributionFiles(root), /link/i);
});
