import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { QueueBridge } from "./bridge.mjs";

const threadId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
async function fixture(t, enqueue) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-queue-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sessionsRoot = path.join(directory, "sessions");
  await fs.mkdir(sessionsRoot);
  const history = path.join(sessionsRoot, `rollout-${threadId}.jsonl`);
  await fs.writeFile(history, JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: directory } }) + "\n");
  const config = { codexBin: process.execPath, sessionsRoot, dataDir: path.join(directory, "receipts"), allowedRoots: [directory], allowedThreadIds: [threadId] };
  return { config, history, bridge: new QueueBridge({ config, enqueue }) };
}

test("durable same-request retry queues exactly once, including after restart", async t => {
  let calls = 0;
  const enqueue = async () => { calls++; return `Queued message 44444444-4444-4444-8444-444444444444 for thread ${threadId}.`; };
  const { bridge, config } = await fixture(t, enqueue);
  const first = await bridge.send({ threadId, message: "hello", requestId });
  assert.equal(first.delivery, "queued");
  await bridge.send({ threadId, message: "hello", requestId });
  await new QueueBridge({ config, enqueue }).send({ threadId, message: "hello", requestId });
  assert.equal(calls, 1);
  await assert.rejects(bridge.send({ threadId, message: "changed", requestId }), /different/i);
});

test("unknown queue result is preserved and never blindly retried", async t => {
  let calls = 0;
  const { bridge } = await fixture(t, async () => { calls++; throw new Error("timeout"); });
  assert.equal((await bridge.send({ threadId, message: "hello", requestId })).delivery, "unknown");
  assert.equal((await bridge.send({ threadId, message: "hello", requestId })).delivery, "unknown");
  assert.equal(calls, 1);
});

test("thread allowlist and canonical workspace checks happen before enqueue", async t => {
  let calls = 0;
  const { bridge, config } = await fixture(t, async () => { calls++; });
  await assert.rejects(bridge.send({ threadId: requestId, message: "hi" }), /allowed/i);
  config.allowedRoots = [path.join(os.tmpdir(), "other-project")];
  await assert.rejects(bridge.send({ threadId, message: "hi" }), /workspace|root/i);
  assert.equal(calls, 0);
});

test("read finds this request's new turn and survives a server restart", async t => {
  const { bridge, config, history } = await fixture(t, async () => `Queued message 44444444-4444-4444-8444-444444444444 for thread ${threadId}.`);
  await bridge.send({ threadId, message: "hello", requestId });
  const rows = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "new-turn" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `[codex-queue-mcp request=${requestId}]\nhello` }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "new reply" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "new-turn", last_agent_message: "new reply" } },
  ];
  await fs.appendFile(history, rows.map(JSON.stringify).join("\n") + "\n");
  const result = await new QueueBridge({ config }).read({ requestId });
  assert.equal(result.status, "completed");
  assert.equal(result.reply, "new reply");
});

test("roots policy accepts another exact thread ID without changing the allowlist", async t => {
  const otherId = "55555555-5555-4555-8555-555555555555";
  let calls = 0;
  const { config } = await fixture(t);
  config.threadPolicy = "roots";
  const cwd = config.allowedRoots[0];
  await fs.writeFile(path.join(config.sessionsRoot, `rollout-${otherId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: otherId, cwd } }) + "\n");
  const bridge = new QueueBridge({ config, enqueue: async id => { calls++; return `Queued message ${requestId} for thread ${id}.`; } });
  assert.equal((await bridge.send({ threadId: otherId, message: "hi" })).delivery, "queued");
  assert.equal(calls, 1);
});

test("omitting the ID creates and opens one thread; retry after restart never creates again", async t => {
  const { config } = await fixture(t);
  config.defaultCwd = config.allowedRoots[0];
  config.threadPolicy = "roots";
  config.openInApp = true;
  let creates = 0, opens = 0, sends = 0;
  const dependencies = {
    config,
    createThread: async cwd => { creates++; assert.equal(cwd, config.defaultCwd); return threadId; },
    openThread: async id => { opens++; assert.equal(id, threadId); },
    enqueue: async id => { sends++; return `Queued message ${requestId} for thread ${id}.`; },
  };
  const first = await new QueueBridge(dependencies).send({ message: "hello", requestId });
  assert.equal(first.delivery, "queued");
  assert.equal(first.threadId, threadId);
  assert.equal(first.createdNewThread, true);
  await new QueueBridge(dependencies).send({ message: "hello", requestId });
  assert.deepEqual([creates, opens, sends], [1, 1, 1]);
});

test("uncertain creation is never repeated, and invalid workspace never creates a thread", async t => {
  const { config } = await fixture(t);
  config.defaultCwd = config.allowedRoots[0];
  let creates = 0;
  const bridge = new QueueBridge({ config, createThread: async () => { creates++; throw new Error("connection lost"); } });
  const first = await bridge.send({ message: "hi", requestId });
  assert.equal(first.delivery, "unknown");
  assert.equal(first.threadId, null);
  await bridge.send({ message: "hi", requestId });
  assert.equal(creates, 1);
  await assert.rejects(bridge.send({ message: "hi", cwd: path.join(os.tmpdir(), "not-authorized") }), /workspace|root/i);
  assert.equal(creates, 1);
});

test("any-project policy permits local sessions without roots or an ID allowlist", async t => {
  const { config } = await fixture(t);
  config.threadPolicy = "any";
  delete config.allowedRoots;
  delete config.allowedThreadIds;
  const bridge = new QueueBridge({ config, enqueue: async id => `Queued message ${requestId} for thread ${id}.` });
  assert.equal((await bridge.send({ threadId, message: "hello" })).delivery, "queued");
});

test("new sessions default to the Claude caller directory, never a stale configured project", async t => {
  const { config } = await fixture(t);
  const callerCwd = path.join(config.allowedRoots[0], "another-project");
  await fs.mkdir(callerCwd);
  config.threadPolicy = "any";
  config.defaultCwdSource = "caller";
  config.defaultCwd = config.allowedRoots[0];
  let createdIn;
  const bridge = new QueueBridge({
    config, callerCwd,
    createThread: async cwd => {
      createdIn = cwd;
      await fs.writeFile(path.join(config.sessionsRoot, `rollout-${threadId}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd } }) + "\n");
      return threadId;
    },
    enqueue: async id => `Queued message ${requestId} for thread ${id}.`,
  });
  assert.equal((await bridge.send({ message: "hello" })).delivery, "queued");
  assert.equal(createdIn, callerCwd);
});

test("long replies are complete by default, with optional Unicode-safe limits in read and wait", async t => {
  const { bridge, history } = await fixture(t, async id => `Queued message ${requestId} for thread ${id}.`);
  await bridge.send({ threadId, message: "long reply test", requestId });
  const reply = "😀".repeat(30001) + "结束";
  const rows = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "long-turn" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `[codex-queue-mcp request=${requestId}]` }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "long-turn", last_agent_message: reply } },
  ];
  await fs.appendFile(history, rows.map(JSON.stringify).join("\n") + "\n");
  const full = await bridge.read({ requestId });
  assert.ok(full.reply === reply, "the full reply must survive without truncation");
  assert.equal(full.truncated, false);
  assert.equal(full.replyChars, 30003);
  const limited = await bridge.read({ requestId, maxReplyChars: 3 });
  assert.equal(limited.reply, "😀😀😀");
  assert.equal(limited.truncated, true);
  assert.equal(limited.replyChars, 30003);
  const waited = await bridge.wait({ requestId, timeoutSeconds: 0, maxReplyChars: 2 });
  assert.equal(waited.reply, "😀😀");
  await assert.rejects(bridge.read({ requestId, maxReplyChars: -1 }), /maxReplyChars/);
});
