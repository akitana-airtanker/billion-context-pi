import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens, lastUserMessageId, lastProviderPromptTokens } from "../src/tokens.js";

test("estimateTokens matches kernel defaultCountTokens (CJK 1:1 + chars/4)", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "hello world foo bar baz" },
  ];
  // defaultCountTokens (acp-kernel 0.0.7+): CJK 1:1 + non-CJK chars/4.
  // 24 non-CJK chars → ceil(24/4) = 6
  assert.equal(estimateTokens(msgs), 6);
});

test("estimateTokens is consistent with kernel counter for CJK (each char = 1 token)", () => {
  const zh = "这是一个中文测试";
  const msgs = [{ id: "m1", role: "user", contentType: "text", text: zh }];
  // 8 CJK chars → 8 tokens under defaultCountTokens; chars/4 would give 2
  assert.equal(estimateTokens(msgs), 8);
});

test("estimateTokens skips compress tool calls", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "alpha beta gamma" },
    { id: "m2", role: "assistant", contentType: "tool-call", toolName: "compress", text: "ignored payload here" },
    { id: "m3", role: "user", contentType: "text", text: "delta epsilon" },
  ];
  // m1 (4) + skip m2 (compress) + m3 (4) = 8
  assert.equal(estimateTokens(msgs), 8);
});

test("estimateTokens skips covered (already-compressed) message ids", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "alpha beta gamma" },
    { id: "m3", role: "user", contentType: "text", text: "delta epsilon" },
  ];
  const covered = new Set(["m3"]);
  // m1 (4) + skip m3 (covered) = 4
  assert.equal(estimateTokens(msgs, covered), 4);
});

test("lastUserMessageId returns the id of the last user-role entry", () => {
  const entries = [
    { id: "a", message: { role: "user" } },
    { id: "b", message: { role: "assistant" } },
    { id: "c", message: { role: "user" } },
    { id: "d", message: { role: "toolResult" } },
  ];
  assert.equal(lastUserMessageId(entries), "c", "last user message is c");
});

test("lastUserMessageId returns undefined when no user message exists", () => {
  const entries = [
    { id: "a", message: { role: "assistant" } },
    { id: "b", message: { role: "toolResult" } },
  ];
  assert.equal(lastUserMessageId(entries), undefined);
});

test("lastUserMessageId returns undefined for empty entries", () => {
  assert.equal(lastUserMessageId([]), undefined);
});

test("lastUserMessageId handles entries without message field", () => {
  const entries = [
    { id: "a" },
    { id: "b", message: { role: "user" } },
  ];
  assert.equal(lastUserMessageId(entries), "b", "skips entries without message");
});

test("lastProviderPromptTokens sums input+cacheRead+cacheWrite of the last assistant usage", () => {
  const entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant", usage: { input: 100_000, cacheRead: 50_000, cacheWrite: 10_000 } } },
    { type: "message", message: { role: "toolResult" } },
  ];
  assert.equal(lastProviderPromptTokens(entries), 160_000);
});

test("lastProviderPromptTokens returns the LAST assistant usage, not the first", () => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 1_000, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", message: { role: "assistant", usage: { input: 200_000, cacheRead: 0, cacheWrite: 0 } } },
  ];
  assert.equal(lastProviderPromptTokens(entries), 200_000);
});

test("lastProviderPromptTokens skips non-message entries and non-assistant roles", () => {
  const entries = [
    { type: "thinking", message: { role: "assistant", usage: { input: 500, cacheRead: 0, cacheWrite: 0 } } },
    { type: "message", message: { role: "user" } },
  ];
  assert.equal(lastProviderPromptTokens(entries), 0);
});

test("lastProviderPromptTokens treats a zero usage as absent", () => {
  const entries = [
    { type: "message", message: { role: "assistant", usage: { input: 0, cacheRead: 0, cacheWrite: 0 } } },
  ];
  assert.equal(lastProviderPromptTokens(entries), 0);
});

test("lastProviderPromptTokens returns 0 for empty entries", () => {
  assert.equal(lastProviderPromptTokens([]), 0);
});
