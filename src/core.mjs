export function parseReply(text, requestId) {
  const marker = `[codex-queue-mcp request=${requestId}]`;
  const turns = new Map();
  const matches = [];
  let currentId;
  const rows = text.split("\n");
  // A writer can be halfway through its last JSONL record. Never parse that fragment.
  if (!text.endsWith("\n")) rows.pop();
  const turn = id => {
    if (!turns.has(id)) turns.set(id, { turnId: id, replies: [], status: "in_progress" });
    return turns.get(id);
  };
  for (const row of rows) {
    if (!row.trim()) continue;
    let record;
    try { record = JSON.parse(row); }
    catch { throw new Error("History contains an invalid completed JSONL record"); }
    const p = record.payload;
    if (!p) continue;
    if (record.type === "turn_context" && p.turn_id) currentId = p.turn_id;
    if (record.type === "event_msg" && p.type === "task_started") currentId = p.turn_id;
    if (!currentId) continue;
    const state = turn(currentId);
    if (record.type === "response_item" && p.type === "message") {
      const body = (p.content ?? []).filter(c => ["input_text", "output_text"].includes(c.type)).map(c => c.text).join("\n");
      if (p.role === "user" && body.split(/\r?\n/).includes(marker)) {
        matches.push(state);
        state.matched = true;
        state.replies = [];
      }
      if (state.matched && p.role === "assistant" && p.phase === "final_answer") state.replies.push(body);
    }
    if (record.type === "event_msg" && p.turn_id === currentId) {
      if (p.type === "task_complete") {
        state.status = "completed";
        if (state.matched && !state.replies.length && typeof p.last_agent_message === "string") state.replies.push(p.last_agent_message);
      } else if (p.type === "turn_aborted") state.status = "interrupted";
      else if (p.type === "task_failed") state.status = "failed";
    }
  }
  if (!matches.length) return { status: "pending", replies: [] };
  if (matches.length !== 1) return { status: "ambiguous", replies: [] };
  const { matched, ...result } = matches[0];
  return { ...result, association: "same_turn_not_exclusive" };
}
