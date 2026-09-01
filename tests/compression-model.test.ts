import { test } from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import {
  buildCompressionPrompt,
  extractAssistantText,
  serializeCompressionMessages,
  type CompressionModelConfig,
} from "../src/compression-model.js";
import { resolveCompressionModel, type AdapterConfig } from "../src/config.js";

const messages: CoreMessage[] = [
  { id: "m00001", role: "user", contentType: "text", text: "先頭の要求" },
  { id: "m00002", role: "assistant", contentType: "tool-call", toolName: "bash", toolCallId: "call-1", text: "{\"command\":\"pwd\"}" },
  { id: "m00003", role: "tool", contentType: "tool-result", toolName: "bash", toolCallId: "call-1", text: "/tmp/project" },
];

test("resolveCompressionModel returns disabled when no model is configured", () => {
  assert.equal(resolveCompressionModel({}), undefined);
  assert.equal(resolveCompressionModel({ compress: {} }), undefined);
});

test("resolveCompressionModel applies the documented Luna defaults", () => {
  const config = resolveCompressionModel({
    compress: { compressionModel: { provider: "openai-codex", model: "gpt-5.6-luna" } },
  });
  assert.deepEqual(config, {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "xhigh",
  });
});

test("serializeCompressionMessages preserves refs, roles, content kinds, and tool links", () => {
  const serialized = serializeCompressionMessages(messages);
  assert.match(serialized, /<message id="m00001" role="user" content-type="text">/);
  assert.match(serialized, /<message id="m00002" role="assistant" content-type="tool-call" tool="bash" call="call-1">/);
  assert.match(serialized, /<message id="m00003" role="tool" content-type="tool-result" tool="bash" call="call-1">/);
  assert.match(serialized, /先頭の要求/);
  assert.match(serialized, /<message id="m00002"/);
});

test("buildCompressionPrompt includes the topic and forbids dropping decisions", () => {
  const config: CompressionModelConfig = {
    provider: "openai-codex",
    model: "gpt-5.6-luna",
    thinkingLevel: "xhigh",
  };
  const prompt = buildCompressionPrompt(messages, "Release investigation", config);
  assert.match(prompt, /Release investigation/);
  assert.match(prompt, /m00001/);
  assert.match(prompt, /paths|signatures|decisions/i);
  assert.match(prompt, /summary only/i);
});

test("extractAssistantText accepts text content blocks and rejects empty output", () => {
  assert.equal(extractAssistantText({ content: [{ type: "text", text: "要約" }] }), "要約");
  assert.equal(extractAssistantText({ content: [{ type: "thinking", thinking: "hidden" }] }), undefined);
  assert.equal(extractAssistantText({ content: [{ type: "text", text: "  " }] }), undefined);
});

// Keep the imported AdapterConfig in the test's type-check surface so routing
// config remains assignable to the public adapter configuration.
const adapterTypeCheck: AdapterConfig = { compress: { compressionModel: undefined } };
void adapterTypeCheck;
