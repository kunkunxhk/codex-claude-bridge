import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { launchClaudeWindow } from "./claude-window.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const terminal = new Set(["completed", "denied", "refused", "expired", "dropped", "interrupted", "startup_pending"]);
function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("An exact sessionId/requestId UUID is required");
  return value.toLowerCase();
}

export class ClaudeTerminalBridge {
  constructor({ dataDir, adapter, peerFactory, claudeBin, pythonBin, launchSession, callerCwd = process.cwd(), startupTimeoutMs = 25000 }) {
    this.dataDir = dataDir;
    this.adapter = adapter;
    this.peerFactory = peerFactory ?? (() => new adapter.PeerEndpoint({ name: "Codex terminal task bridge", cwd: process.cwd(), signalExit: false }));
    this.peer = null;
    this.callerCwd = callerCwd;
    this.startupTimeoutMs = startupTimeoutMs;
    this.launchSession = launchSession ?? (options => launchClaudeWindow({ executable: claudeBin, pythonBin, dataDir, ...options }));
  }

  sessions() { return this.adapter.listClaudeSessions().filter(s => s.alive && s.entrypoint === "cli" && UUID.test(s.sessionId ?? "")); }
  list() { return this.sessions().map(({ sessionId, name, cwd, pid, startedAt }) => ({ sessionId, name: name ?? null, cwd, pid: pid ?? null, startedAt: startedAt ?? null })); }
  file(requestId) { return path.join(this.dataDir, `${uuid(requestId)}.json`); }

  async load(requestId) {
    const file = this.file(requestId);
    if ((await fs.stat(file)).size > 32 * 1024 * 1024) throw new Error("Receipt exceeds the supported read size");
    const receipt = JSON.parse(await fs.readFile(file, "utf8"));
    if (receipt.requestId !== uuid(requestId)) throw new Error("Receipt identity mismatch");
    return receipt;
  }

  async save(receipt) {
    const file = this.file(receipt.requestId), temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    try { await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }

  publicReceipt(receipt) {
    return {
      requestId: receipt.requestId, sessionId: receipt.sessionId, cwd: receipt.cwd,
      delivery: receipt.delivery, createdAt: receipt.createdAt,
      createdNewSession: receipt.createdNewSession ?? false, stage: receipt.stage ?? "sent",
      terminalName: receipt.name ?? null, pid: receipt.pid ?? null,
      nextAction: receipt.stage === "startup_pending"
        ? "No task was sent. Finish any login/trust prompt in the visible terminal, then use its sessionId for an explicit new send request. Do not launch another window."
        : "Wait/read the same requestId. Never resend uncertain delivery. Recipient permissions may require manual approval; this bridge never grants it.",
    };
  }

  async send({ sessionId, message, cwd, requestId = randomUUID() }) {
    requestId = uuid(requestId);
    const explicitId = sessionId === undefined ? null : uuid(sessionId);
    let target = explicitId ? this.sessions().find(s => s.sessionId.toLowerCase() === explicitId) : null;
    if (explicitId && !target) throw new Error("The exact sessionId must identify a live terminal session from claude_terminal_list. It was not replaced by a new session.");
    if (typeof message !== "string" || !message.trim() || message.includes("\0") || Buffer.byteLength(message, "utf8") > 16000) throw new Error("Message must contain 1..16000 UTF-8 bytes, without NUL");
    const project = target?.cwd ?? cwd ?? this.callerCwd;
    if (typeof project !== "string" || !path.isAbsolute(project)) throw new Error("An absolute current project cwd is required");
    const targetCwd = await fs.realpath(project);
    if (!(await fs.stat(targetCwd)).isDirectory()) throw new Error("Project cwd must be an existing directory");
    if (target && cwd && await fs.realpath(cwd) !== targetCwd) throw new Error("cwd cannot change an existing Claude session's project");
    const digest = createHash("sha256").update((explicitId ?? `new:${targetCwd}`) + "\0" + message).digest("hex");
    const selectedId = explicitId ?? randomUUID();
    const receipt = {
      requestId, sessionId: selectedId, cwd: targetCwd, socket: target?.socket ?? null,
      digest, delivery: "unknown", createdAt: new Date().toISOString(),
      createdNewSession: !explicitId, stage: explicitId ? "ready" : "starting",
      name: target?.name ?? `codex-task-${selectedId.slice(0, 8)}`, pid: target?.pid ?? null,
    };
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    try { await fs.writeFile(this.file(requestId), JSON.stringify(receipt), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await this.load(requestId);
      if (previous.digest !== digest) throw new Error("Request ID already belongs to a different message/session");
      return this.publicReceipt(previous);
    }
    try {
      if (!explicitId) {
        const launched = await this.launchSession({ sessionId: selectedId, cwd: targetCwd, name: receipt.name });
        receipt.pid = launched?.pid ?? null;
        await this.save(receipt);
        const deadline = Date.now() + this.startupTimeoutMs;
        while (true) {
          target = this.sessions().find(s => s.sessionId.toLowerCase() === selectedId);
          if (target) break;
          if (Date.now() >= deadline) {
            receipt.stage = "startup_pending";
            receipt.delivery = "not_sent";
            await this.save(receipt);
            return this.publicReceipt(receipt);
          }
          await delay(Math.min(250, deadline - Date.now()));
        }
        if (await fs.realpath(target.cwd) !== targetCwd) throw new Error("New Claude session registered a different project directory");
        receipt.pid = target.pid ?? receipt.pid;
        receipt.socket = target.socket;
      }
      this.peer ??= this.peerFactory();
      await this.peer.start();
      receipt.stage = "sending";
      await this.save(receipt);
      // Transport metadata identifies Codex as the sender. It never claims to be a human
      // or declares bypassPermissions. The recipient retains its native inbound checks.
      await this.peer.send(target.socket, message, { msgId: requestId });
      receipt.delivery = "sent_unconfirmed";
      receipt.stage = "sent";
    } catch (error) {
      receipt.errorCode = typeof error.code === "string" ? error.code : "CLAUDE_DELIVERY_UNKNOWN";
      if (receipt.stage !== "sending") {
        receipt.delivery = "not_sent";
        receipt.stage = "startup_pending";
      }
    }
    await this.save(receipt);
    return this.publicReceipt(receipt);
  }

  async read({ requestId }) {
    const receipt = await this.load(uuid(requestId));
    if (receipt.result) return { ...this.publicReceipt(receipt), ...receipt.result };
    if (receipt.stage === "startup_pending") return { ...this.publicReceipt(receipt), status: "startup_pending", reply: "", recipientOnline: this.sessions().some(s => s.sessionId === receipt.sessionId) };
    // Native message UUID/peer origin and transcript ancestry correlate the answer;
    // arbitrary matching text from a different turn is never considered a reply.
    const outcome = this.adapter.readTranscriptOutcome(receipt.sessionId, receipt.cwd, receipt.requestId);
    const status = this.peer?.deliveryReceipts?.get(receipt.requestId);
    let result;
    if (typeof outcome?.reply?.text === "string") result = { status: "completed", reply: outcome.reply.text, source: "native_peer_transcript", association: "native_message_chain" };
    else if (outcome?.status === "interrupted") result = { status: "interrupted", reply: "", reason: outcome.reason ?? "Recipient turn was interrupted" };
    else result = { status: status?.status ?? "pending", reply: "", reason: status?.reason ?? null, recipientOnline: this.sessions().some(s => s.sessionId === receipt.sessionId) };
    if (terminal.has(result.status)) { receipt.result = result; await this.save(receipt); }
    return { ...this.publicReceipt(receipt), ...result };
  }

  async wait({ requestId, timeoutSeconds = 35 }, signal) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 45) throw new Error("timeoutSeconds must be 0..45");
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      signal?.throwIfAborted();
      const result = await this.read({ requestId });
      if (terminal.has(result.status) || Date.now() >= deadline) return { ...result, timedOut: !terminal.has(result.status) };
      await delay(Math.min(750, deadline - Date.now()), undefined, { signal });
    }
  }

  stop() { this.peer?.stop(); }
}
