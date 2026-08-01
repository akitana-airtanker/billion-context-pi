import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateTokens } from "../src/tokens.js";

test("estimateTokens matches kernel defaultCountTokens (word-based, not chars/4)", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "hello world foo bar baz" },
  ];
  // defaultCountTokens counts ascii words: 5 — chars/4 would give 2
  assert.equal(estimateTokens(msgs), 5);
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
  // m1 (3) + skip m2 (compress) + m3 (2) = 5
  assert.equal(estimateTokens(msgs), 5);
});

test("estimateTokens skips covered (already-compressed) message ids", () => {
  const msgs = [
    { id: "m1", role: "user", contentType: "text", text: "alpha beta gamma" },
    { id: "m3", role: "user", contentType: "text", text: "delta epsilon" },
  ];
  const covered = new Set(["m3"]);
  // m1 (3) + skip m3 (covered) = 3
  assert.equal(estimateTokens(msgs, covered), 3);
});
