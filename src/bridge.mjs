import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { parseReply } from "./core.mjs";
import { createDesktopThread, openDesktopThread } from "./desktop.mjs";

const execute = promisify(execFile);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_HISTORY_BYTES = 32 * 1024 * 1024;
const terminalStatuses = new Set(["completed", "interrupted", "failed", "ambiguous", "creation_unconfirmed"]);

function uuid(value) {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error("An exact UUID is required");
  return value.toLowerCase();
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function readRange(file, start, limit) {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    if (size < start) throw new Error("History was truncated; request correlation cannot be verified");
    const length = size - start;
    if (length > limit) throw new Error("History exceeds the supported read limit");
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally { await handle.close(); }
}

async function metadata(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0];
    const record = JSON.parse(first);
    if (record.type !== "session_meta") throw new Error("Unsupported history metadata");
    return record.payload;
  } finally { await handle.close(); }
}

export class QueueBridge {
  constructor({ config, enqueue, createThread, openThread, callerCwd = process.cwd() }) {
    this.config = config;
    this.callerCwd = callerCwd;
    this.createThread = createThread ?? ((cwd, onCreated) => createDesktopThread(config, cwd, onCreated));
    this.openThread = openThread ?? openDesktopThread;
    this.enqueue = enqueue ?? (async (threadId, message) => {
      const result = await execute(config.codexBin, ["queue", "--thread", threadId, "--message", message], {
        shell: false, windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
        env: { ...process.env, CODEX_HOME: config.codexHome },
      });
      return result.stdout;
    });
    this.sessions = new Map();
  }

  receiptPath(requestId) { return path.join(this.config.dataDir, `${uuid(requestId)}.json`); }

  async loadReceipt(requestId) {
    const text = await readRange(this.receiptPath(requestId), 0, 65536);
    const receipt = JSON.parse(text);
    if (receipt.requestId !== uuid(requestId)) throw new Error("Invalid request receipt");
    return receipt;
  }

  async saveReceipt(receipt) {
    const file = this.receiptPath(receipt.requestId);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 });
    try { await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
  }

  publicReceipt(receipt) {
    return {
      requestId: receipt.requestId, threadId: receipt.threadId, delivery: receipt.delivery,
      queueId: receipt.queueId ?? null, createdAt: receipt.createdAt,
      desktopLink: receipt.threadId ? `codex://threads/${receipt.threadId}` : null,
      createdNewThread: receipt.createdNewThread ?? false,
      desktopOpenRequested: receipt.desktopOpenRequested ?? false,
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      nextAction: "Use codex_queue_wait/read with this requestId. Queued is not completed; never resend an uncertain request.",
    };
  }

  async session(threadId) {
    threadId = uuid(threadId);
    if (!["roots", "any"].includes(this.config.threadPolicy) && !this.config.allowedThreadIds.map(uuid).includes(threadId)) throw new Error("Thread is not allowed in settings.json");
    if (!this.sessions.has(threadId)) {
      const matches = [];
      let inspected = 0;
      const walk = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (++inspected > 100000) throw new Error("Session discovery exceeded its limit");
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) matches.push(file);
        }
      };
      await walk(this.config.sessionsRoot);
      if (matches.length !== 1) throw new Error("History unavailable or ambiguous: an existing local JSONL session is required");
      this.sessions.set(threadId, matches[0]);
    }
    const file = await fs.realpath(this.sessions.get(threadId));
    if (!inside(await fs.realpath(this.config.sessionsRoot), file)) throw new Error("History path is outside the configured sessions root");
    const meta = await metadata(file);
    if (meta.id !== threadId) throw new Error("History identity mismatch");
    const cwd = await this.workspace(meta.cwd);
    return { file, cwd };
  }

  async workspace(input) {
    if (typeof input !== "string" || !path.isAbsolute(input)) throw new Error("Workspace must be an absolute directory");
    let cwd;
    try { cwd = await fs.realpath(input); }
    catch { throw new Error("Workspace must be an existing allowed directory"); }
    if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Workspace must be a directory");
    if (this.config.threadPolicy === "any") return cwd;
    let allowed = false;
    for (const root of this.config.allowedRoots) {
      try { if (inside(await fs.realpath(root), cwd)) allowed = true; }
      catch { /* A missing authorized root cannot authorize a workspace. */ }
    }
    if (!allowed) throw new Error("Thread workspace is outside the allowed roots");
    return cwd;
  }

  async send({ threadId, message, cwd, requestId = randomUUID() }) {
    threadId = threadId === undefined ? null : uuid(threadId);
    requestId = uuid(requestId);
    if (typeof message !== "string" || !message.trim() || message.includes("\0") || message.includes("[codex-queue-mcp request=")) throw new Error("Invalid or empty message");
    const prompt = `[codex-queue-mcp request=${requestId}]\n${message}`;
    if (Buffer.byteLength(prompt, "utf8") > 16000) throw new Error("Message exceeds 16000 UTF-8 bytes");
    let session = threadId ? await this.session(threadId) : null;
    const defaultCwd = this.config.defaultCwdSource === "caller" ? this.callerCwd : this.config.defaultCwd;
    const targetCwd = session ? session.cwd : await this.workspace(cwd ?? defaultCwd);
    if (session && cwd && await this.workspace(cwd) !== session.cwd) throw new Error("Provided workspace does not match the existing thread");
    // Keep the old digest for explicit IDs so existing retry receipts remain compatible.
    const digest = createHash("sha256").update((threadId ?? `new:${targetCwd}`) + "\0" + message).digest("hex");
    await fs.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    const receipt = {
      requestId, threadId, digest, createdAt: new Date().toISOString(), delivery: "unknown",
      historyOffset: session ? (await fs.stat(session.file)).size : null, cwd: targetCwd,
      createdNewThread: !threadId,
    };
    // Claim the ID durably BEFORE starting the CLI. Concurrent retries must not send twice.
    try { await fs.writeFile(this.receiptPath(requestId), JSON.stringify(receipt, null, 2), { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = await this.loadReceipt(requestId);
      if (previous.digest !== digest) throw new Error("Request ID was already used for a different message or thread");
      return this.publicReceipt(previous);
    }
    try {
      if (!threadId) {
        threadId = uuid(await this.createThread(targetCwd, async createdId => {
          receipt.threadId = uuid(createdId);
          await this.saveReceipt(receipt);
        }));
        receipt.threadId = threadId;
        await this.saveReceipt(receipt);
        session = await this.session(threadId);
        receipt.historyOffset = (await fs.stat(session.file)).size;
        await this.saveReceipt(receipt);
      }
      if (this.config.openInApp) {
        await this.openThread(threadId);
        receipt.desktopOpenRequested = true;
      }
      const stdout = await this.enqueue(threadId, prompt);
      const match = /^Queued message ([a-f0-9-]{36}) for thread ([a-f0-9-]{36})\./im.exec(stdout);
      if (match && UUID.test(match[1]) && match[2].toLowerCase() === threadId) {
        receipt.delivery = "queued";
        receipt.queueId = match[1];
      }
    } catch (error) {
      // The process may have queued successfully before a timeout/disconnect. Never auto-retry.
      receipt.errorCode = typeof error.code === "string" ? error.code : "QUEUE_RESULT_UNKNOWN";
    }
    await this.saveReceipt(receipt);
    return this.publicReceipt(receipt);
  }

  async read({ requestId, maxReplyChars }) {
    if (maxReplyChars !== undefined && (!Number.isSafeInteger(maxReplyChars) || maxReplyChars < 1)) throw new Error("maxReplyChars must be a positive safe integer, or omitted for the full reply");
    const receipt = await this.loadReceipt(uuid(requestId));
    if (!receipt.threadId || receipt.historyOffset === null) return { ...this.publicReceipt(receipt), status: "creation_unconfirmed", reply: "", replyChars: 0, truncated: false };
    const session = await this.session(receipt.threadId);
    if (session.cwd !== receipt.cwd) throw new Error("Thread workspace changed since submission");
    const result = parseReply(await readRange(session.file, receipt.historyOffset, MAX_HISTORY_BYTES), receipt.requestId);
    const reply = result.replies.join("\n\n");
    let replyChars = 0;
    let end = 0;
    for (const character of reply) {
      replyChars++;
      if (maxReplyChars === undefined || replyChars <= maxReplyChars) end += character.length;
    }
    const { replies, ...state } = result;
    return {
      ...this.publicReceipt(receipt), ...state,
      reply: reply.slice(0, end), replyChars, truncated: end < reply.length,
      note: "Only this request's matched turn is read. Multiple inputs may share a turn; this is not proof of an exclusive reply. No reasoning or tool outputs are returned.",
    };
  }

  async wait({ requestId, timeoutSeconds = 35, maxReplyChars }, signal) {
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 45) throw new Error("timeoutSeconds must be 0..45");
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (true) {
      signal?.throwIfAborted();
      const result = await this.read({ requestId, maxReplyChars });
      if (terminalStatuses.has(result.status) || Date.now() >= deadline) return { ...result, timedOut: !terminalStatuses.has(result.status) };
      await delay(Math.min(750, deadline - Date.now()), undefined, { signal });
    }
  }
}
