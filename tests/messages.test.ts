import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesToCoreMessages, coreOutToAgentMessages } from "../src/messages.js";
import type { CoreMessage } from "acp-kernel";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";

function msgEntry(id: string, message: object): SessionMessageEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: message as SessionMessageEntry["message"],
  };
}

function user(text: string): object {
  return { role: "user", content: text, timestamp: Date.now() };
}
function userBlocks(text: string): object {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}
function assistantToolCall(name: string): object {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc1", name, arguments: {} }],
    api: "anthropic",
    provider: "anthropic",
    model: "m",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}
function toolResult(name: string, text: string): object {
  return { role: "toolResult", toolCallId: "tc1", toolName: name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() };
}

test("entriesToCoreMessages projects user/assistant/toolResult roles and extracts text", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("hello world")),
    msgEntry("b", userBlocks("block text")),
    msgEntry("c", assistantToolCall("read")),
    msgEntry("d", toolResult("read", "file contents")),
  ];
  const core = entriesToCoreMessages(entries);

  assert.equal(core[0]!.role, "user");
  assert.equal(core[0]!.text, "hello world");
  assert.equal(core[1]!.text, "block text");
  assert.equal(core[2]!.role, "assistant");
  assert.equal(core[2]!.contentType, "tool-call");
  assert.equal(core[2]!.toolName, "read");
  assert.equal(core[3]!.role, "tool");
  assert.equal(core[3]!.contentType, "tool-result");
  assert.equal(core[3]!.text, "file contents");
});

test("entriesToCoreMessages skips non-message entries (compaction, model_change)", () => {
  const entries: SessionEntry[] = [
    msgEntry("a", user("alpha")),
    { type: "compaction", id: "x", parentId: null, timestamp: "", summary: "s", firstKeptEntryId: "a", tokensBefore: 0 } as SessionEntry,
    { type: "model_change", id: "y", parentId: null, timestamp: "", provider: "p", modelId: "m" } as SessionEntry,
    msgEntry("b", user("beta")),
  ];
  const core = entriesToCoreMessages(entries);
  assert.deepEqual(core.map((m) => m.id), ["a", "b"]);
});

test("coreOutToAgentMessages patches the ref tag onto original messages", () => {
  const original = msgEntry("a", user("hello")).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: "[m00001] hello" }];

  const out = coreOutToAgentMessages(coreOut, originalById);
  const content = (out[0] as { content: Array<{ type: string; text: string }> }).content;
  assert.equal(content[0]!.type, "text");
  assert.equal(content[0]!.text, "[m00001] ");
  assert.equal(content[1]!.text, "hello");
});

test("coreOutToAgentMessages returns original unchanged when no ref tag is present", () => {
  const original = msgEntry("a", user("hello")).message;
  const originalById = new Map([["a", original]]);
  const coreOut: CoreMessage[] = [{ id: "a", role: "user", contentType: "text", text: "hello" }];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out[0], original, "un-tagged message returned by reference, untouched");
});

test("coreOutToAgentMessages filters out synthetic summary messages (compress-as-anchor)", () => {
  const originalById = new Map<string, SessionMessageEntry["message"]>();
  const coreOut: CoreMessage[] = [
    { id: "acp_summary_b0", role: "system", contentType: "text", text: "[Compressed conversation section]\nbody" },
  ];

  const out = coreOutToAgentMessages(coreOut, originalById);
  assert.equal(out.length, 0, "synthetic summary messages should be filtered out");
});
