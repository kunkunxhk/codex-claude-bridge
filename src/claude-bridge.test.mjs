import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ClaudeTerminalBridge } from "./claude-bridge.mjs";

const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
async function fixture(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "claude-terminal-test-"));
  t.after(async () => {
    if (!path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe cleanup path");
    await fs.rm(folder, { recursive: true, force: true });
  });
  let sends = 0;
  const sessions = [{ sessionId, cwd: folder, alive: true, entrypoint: "cli", socket: "test-local-pipe" }];
  const peer = { start: async () => {}, send: async (socket, message, options) => { sends++; assert.equal(options.msgId, requestId); }, stop() {}, deliveryReceipts: new Map() };
  const options = { dataDir: folder, adapter: { listClaudeSessions: () => sessions, readTranscriptOutcome: () => ({ reply: { text: "fresh reply" } }) }, peerFactory: () => peer };
  return { options, sessions, sends: () => sends, bridge: new ClaudeTerminalBridge(options) };
}

test("targets an exact live CLI session and reads its correlated reply after restart", async t => {
  const { bridge, options, sends } = await fixture(t);
  const receipt = await bridge.send({ sessionId, message: "hello", requestId });
  assert.equal(receipt.delivery, "sent_unconfirmed");
  const reply = await new ClaudeTerminalBridge(options).read({ requestId });
  assert.equal(reply.status, "completed");
  assert.equal(reply.reply, "fresh reply");
  await new ClaudeTerminalBridge(options).send({ sessionId, message: "hello", requestId });
  assert.equal(sends(), 1);
  await assert.rejects(bridge.send({ sessionId, message: "changed", requestId }), /different/);
});

test("an explicit missing recipient is never silently replaced", async t => {
  const { bridge, sends } = await fixture(t);
  await assert.rejects(bridge.send({ sessionId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", message: "hello" }), /live/);
  assert.equal(sends(), 0);
});

test("an uncertain pipe write is not retried", async t => {
  const { options, sends } = await fixture(t);
  let attempts = 0;
  options.peerFactory = () => ({ start: async () => {}, send: async () => { attempts++; throw new Error("disconnected"); }, stop() {}, deliveryReceipts: new Map() });
  const bridge = new ClaudeTerminalBridge(options);
  assert.equal((await bridge.send({ sessionId, message: "hello", requestId })).delivery, "unknown");
  await bridge.send({ sessionId, message: "hello", requestId });
  assert.equal(attempts, 1);
  assert.equal(sends(), 0);
});

test("omitting sessionId opens a NEW visible session in caller cwd, and restart retry never opens twice", async t => {
  const { options, sessions, sends } = await fixture(t);
  let launches = 0;
  options.callerCwd = sessions[0].cwd;
  options.launchSession = async launch => {
    launches++;
    assert.equal(launch.cwd, options.callerCwd);
    assert.notEqual(launch.sessionId, sessionId);
    sessions.push({ ...sessions[0], sessionId: launch.sessionId, name: launch.name });
    return { pid: 12345, terminal: "native-console" };
  };
  const first = await new ClaudeTerminalBridge(options).send({ message: "hello", requestId });
  assert.equal(first.createdNewSession, true);
  assert.equal(first.delivery, "sent_unconfirmed");
  assert.notEqual(first.sessionId, sessionId);
  await new ClaudeTerminalBridge(options).send({ message: "hello", requestId });
  assert.equal(launches, 1);
  assert.equal(sends(), 1);
});

test("startup waiting never sends to an older session or launches duplicate windows", async t => {
  const { options, sessions, sends } = await fixture(t);
  let launches = 0;
  options.callerCwd = sessions[0].cwd;
  options.startupTimeoutMs = 0;
  options.launchSession = async () => { launches++; return { pid: 12345, terminal: "native-console" }; };
  const bridge = new ClaudeTerminalBridge(options);
  const receipt = await bridge.send({ message: "hello", requestId });
  assert.equal(receipt.delivery, "not_sent");
  assert.equal(receipt.stage, "startup_pending");
  assert.notEqual(receipt.sessionId, sessionId);
  await bridge.send({ message: "hello", requestId });
  assert.equal(launches, 1);
  assert.equal(sends(), 0);
});

test("list exposes the actual session ID with identifying name, directory and PID", async t => {
  const { options, sessions } = await fixture(t);
  sessions[0].pid = 123;
  sessions[0].name = "project-terminal";
  const [listed] = new ClaudeTerminalBridge(options).list();
  assert.equal(listed.sessionId, sessionId);
  assert.equal(listed.pid, 123);
  assert.equal(listed.name, "project-terminal");
  assert.equal(listed.cwd, sessions[0].cwd);
});

test("launcher failures report no task sent and never launch again on retry", async t => {
  const { options, sessions, sends } = await fixture(t);
  let launches = 0;
  options.callerCwd = sessions[0].cwd;
  options.launchSession = async () => { launches++; throw new Error("launcher unavailable"); };
  const bridge = new ClaudeTerminalBridge(options);
  const result = await bridge.send({ message: "hello", requestId });
  assert.equal(result.delivery, "not_sent");
  assert.equal((await bridge.read({ requestId })).status, "startup_pending");
  await bridge.send({ message: "hello", requestId });
  assert.equal(launches, 1);
  assert.equal(sends(), 0);
});
