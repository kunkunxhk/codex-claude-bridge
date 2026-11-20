import test from "node:test";
import assert from "node:assert/strict";
import { smoke } from "../src/smoke.mjs";
import { sourceRoot } from "../src/runtime.mjs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("both stdio servers initialize and expose read-only readiness tools", { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-smoke-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, "settings.json");
  await fs.writeFile(configFile, JSON.stringify({ codexBin: process.execPath, claudeBin: process.execPath, pythonBin: process.execPath, codexHome: root, claudeHome: root, dataDir: path.join(root, "receipts") }));
  const result = await smoke({ sourceRoot, configFile });
  assert.equal(result.codex.tools.includes("codex_queue_send"), true);
  assert.equal(result.claude.tools.includes("claude_terminal_send"), true);
  assert.equal(result.claude.tools.includes("claude_terminal_list"), true);
  assert.equal(result.modelTaskSent, false);
});
