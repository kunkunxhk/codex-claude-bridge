import test from "node:test";
import assert from "node:assert/strict";
import { parseReply } from "./core.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const marker = `[codex-queue-mcp request=${id}]`;
const event = (type, payload) => JSON.stringify({ type, payload });
const start = turn_id => event("event_msg", { type: "task_started", turn_id });
const message = (role, text, phase) => event("response_item", {
  type: "message", role, phase, content: [{ type: role === "user" ? "input_text" : "output_text", text }],
});
const end = (turn_id, last_agent_message) => event("event_msg", { type: "task_complete", turn_id, last_agent_message });
const parse = rows => parseReply(rows.join("\n") + "\n", id);

test("returns only the final reply of the marked turn, never an old greeting or commentary", () => {
  const result = parse([
    start("old"), message("user", "hi"), message("assistant", "old", "final_answer"), end("old", "old"),
    start("new"), message("user", marker + "\nhello"),
    message("assistant", "working", "commentary"), message("assistant", "你好！", "final_answer"), end("new", "你好！"),
    start("later"), message("user", "other"), message("assistant", "other reply", "final_answer"), end("later", "other reply"),
  ]);
  assert.equal(result.status, "completed");
  assert.equal(result.turnId, "new");
  assert.deepEqual(result.replies, ["你好！"]);
});

test("does not mistake an assistant echo for the user's marked message", () => {
  assert.equal(parse([start("t"), message("assistant", marker, "final_answer"), end("t", marker)]).status, "pending");
});

test("never reports a final answer as completed before the terminal event", () => {
  assert.equal(parse([start("t"), message("user", marker), message("assistant", "answer", "final_answer")]).status, "in_progress");
});

test("refuses duplicate marker matches in separate turns", () => {
  assert.equal(parse([start("a"), message("user", marker), end("a", "a"), start("b"), message("user", marker), end("b", "b")]).status, "ambiguous");
});

test("handles an incomplete trailing line but refuses corrupt completed JSON", () => {
  assert.equal(parseReply(start("t") + "\n" + '{"type":', id).status, "pending");
  assert.throws(() => parseReply("not-json\n", id), /history/i);
});

test("turn completion fallback and interruption retain the matching turn", () => {
  assert.deepEqual(parse([start("t"), message("user", marker), end("t", "fallback")]).replies, ["fallback"]);
  assert.equal(parse([start("t"), message("user", marker), event("event_msg", { type: "turn_aborted", turn_id: "t" })]).status, "interrupted");
});
