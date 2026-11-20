import test from "node:test";
import assert from "node:assert/strict";
import { liveTest } from "../src/live-check.mjs";

test("live test requires explicit exact recipients before starting any MCP", async () => {
  await assert.rejects(() => liveTest({}), /explicit.*ID/i);
  await assert.rejects(() => liveTest({ claudeSession: "invalid" }), /UUID/);
});
