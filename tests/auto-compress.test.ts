import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createAcpExtension } from "../src/index.js";
import {
  AUTO_COMPRESS_DEFAULTS,
  AutoCompressEpisode,
  buildHeuristicSummary,
  messagesInRange,
  pickAutoRanges,
  resolveAutoCompress,
} from "../src/auto-compress.js";

process.env.ACP_AUTO_UPDATE = "false";

function captureApi() {
  const handlers = new Map<string, ((e: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) {
      this.tools.push(tool);
    },
    registerCommand(name: string, options: any) {
      this.commands.set(name, options);
    },
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function fakeCtx(entries: any[], stateFile: string) {
  let usage: { tokens: number; percent: number } | null = null;
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => usage,
    __setUsage(t: number) {
      usage = { tokens: t, percent: t / 200_000 };
    },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const LIMIT = 200_000;
const OLDER = "中".repeat(1500); // 1500 CJK tokens each

// 10 large older + 5 small recent. preserveRecentTokens(5000)+preserveRecentMessages(5)
// protect the tail; the 10-message older zone leaves a >= 5000-char compressible range.
function makeEntries() {
  const older = Array.from({ length: 10 }, (_, i) => userMsg(`e${i + 1}`, OLDER));
  const recent = Array.from({ length: 5 }, (_, i) => userMsg(`r${i + 1}`, "ok"));
  return [...older, ...recent];
}

function readBlocks(stateFile: string): any[] {
  try {
    const raw = JSON.parse(readFileSync(`${stateFile}.acp.json`, "utf8"));
    return raw.blocks ?? [];
  } catch {
    return [];
  }
}

async function fire(handlers: Map<string, any[]>, ctx: any) {
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
}

function setup(adapter: Record<string, unknown>, stateFile: string) {
  const { api, handlers } = captureApi();
  createAcpExtension(adapter as any)(api as any);
  rmSync(`${stateFile}.acp.json`, { force: true });
  const ctx = fakeCtx(makeEntries(), stateFile);
  return { handlers, ctx };
}

// ─── unit tests ────────────────────────────────────────────────────────────

test("resolveAutoCompress: defaults when unset", () => {
  assert.deepEqual(resolveAutoCompress(undefined), AUTO_COMPRESS_DEFAULTS);
  assert.deepEqual(resolveAutoCompress({}), AUTO_COMPRESS_DEFAULTS);
  assert.equal(resolveAutoCompress({ autoCompress: true }).enabled, true);
});

test("resolveAutoCompress: false disables but keeps other defaults", () => {
  const s = resolveAutoCompress({ autoCompress: false });
  assert.equal(s.enabled, false);
  assert.equal(s.afterIgnores, AUTO_COMPRESS_DEFAULTS.afterIgnores);
  assert.equal(s.hardThreshold, AUTO_COMPRESS_DEFAULTS.hardThreshold);
});

test("resolveAutoCompress: object merges + parses percent strings", () => {
  const s = resolveAutoCompress({ autoCompress: { afterIgnores: 5, hardThreshold: "90%", targetPct: "70%", maxRanges: 2 } });
  assert.equal(s.enabled, true);
  assert.equal(s.afterIgnores, 5);
  assert.equal(s.hardThreshold, 0.9);
  assert.equal(s.targetPct, 0.7);
  assert.equal(s.maxRanges, 2);
});

test("AutoCompressEpisode.reset clears streak + lastAutoCompressedTurnKey", () => {
  const ep = new AutoCompressEpisode();
  ep.streak = 3;
  ep.lastAutoCompressedTurnKey = "m00005";
  ep.reset();
  assert.equal(ep.streak, 0);
  assert.equal(ep.lastAutoCompressedTurnKey, null);
});

test("pickAutoRanges: greedy largest-first, stops at target or maxRanges", () => {
  const settings = { ...AUTO_COMPRESS_DEFAULTS, maxRanges: 2, targetPct: 0.8 };
  const nudge = {
    compressibleRanges: [
      { startRef: "m00001", endRef: "m00002", count: 2, tokens: 1000 },
      { startRef: "m00003", endRef: "m00004", count: 2, tokens: 4000 },
      { startRef: "m00005", endRef: "m00006", count: 2, tokens: 200 },
    ],
  } as any;
  // usage 0.90, limit 200000, target 0.80:
  //   4000 → 0.90-0.02=0.88 (not <0.80)
  //   1000 → 0.88-0.005=0.875 (not <0.80)
  //   maxRanges=2 → stop (200 not picked)
  const picked = pickAutoRanges(nudge, 0.9, 200_000, settings);
  assert.deepEqual(picked.map((r) => r.tokens), [4000, 1000]);
});

test("pickAutoRanges: empty when no nudge", () => {
  assert.deepEqual(pickAutoRanges(undefined, 0.9, 200_000, AUTO_COMPRESS_DEFAULTS), []);
});

test("buildHeuristicSummary: labeled per-message index with snippet truncation", () => {
  const msgs = [
    { id: "a", role: "user", contentType: "text", text: "hello " + "x".repeat(300) },
    { id: "b", role: "assistant", contentType: "tool-call", toolName: "bash", text: "ls -la" },
    { id: "c", role: "assistant", contentType: "tool-result", toolName: "bash", text: "file1 file2" },
  ] as any[];
  const s = buildHeuristicSummary(msgs, "m00001", "m00003");
  assert.ok(s.includes("AUTO-COMPRESSED by ACP enforcement"));
  assert.ok(s.includes("Range m00001..m00003"));
  assert.ok(s.includes("[user] hello"));
  assert.ok(s.includes("[tool-call bash] ls -la"));
  assert.ok(s.includes("[tool-result bash] file1 file2"));
  assert.ok(s.includes("…"), "long snippet truncated");
});

test("buildHeuristicSummary: hard-caps total length", () => {
  const msgs = Array.from({ length: 80 }, (_, i) => ({
    id: `m${i}`, role: "user", contentType: "text", text: "y".repeat(500),
  })) as any[];
  const s = buildHeuristicSummary(msgs, "m00001", "m00080");
  assert.ok(s.includes("summary truncated"));
  assert.ok(s.length <= 12_000 + 50);
});

test("messagesInRange: inclusive [start,end] by ref", () => {
  const refMap = { byRaw: { a: "m00001", b: "m00002", c: "m00003", d: "m00004" }, byRef: {} } as any;
  const msgs = [
    { id: "a", role: "user", contentType: "text", text: "1" },
    { id: "b", role: "user", contentType: "text", text: "2" },
    { id: "c", role: "user", contentType: "text", text: "3" },
    { id: "d", role: "user", contentType: "text", text: "4" },
  ] as any[];
  assert.deepEqual(messagesInRange(msgs, refMap, "m00002", "m00003").map((m) => m.id), ["b", "c"]);
});

// ─── e2e tests ─────────────────────────────────────────────────────────────

test("e2e: auto-compress fires after N ignored over-limit nudges (streak)", async () => {
  const stateFile = "/tmp/pai-acp-auto-streak.session.json";
  const { handlers, ctx } = setup({ modelContextLimit: LIMIT }, stateFile);
  ctx.__setUsage(0.85 * LIMIT); // overLimit (>=0.75), not hard (<0.95), above target (0.80)
  await fire(handlers, ctx);
  assert.equal(readBlocks(stateFile).length, 0, "no block after 1 ignored nudge");
  await fire(handlers, ctx);
  assert.equal(readBlocks(stateFile).length, 0, "no block after 2 ignored nudges");
  await fire(handlers, ctx);
  assert.ok(readBlocks(stateFile).length >= 1, "block created after 3 ignored nudges");
});

test("e2e: auto-compress fires immediately at hard threshold", async () => {
  const stateFile = "/tmp/pai-acp-auto-hard.session.json";
  const { handlers, ctx } = setup({ modelContextLimit: LIMIT }, stateFile);
  ctx.__setUsage(0.96 * LIMIT); // >= 0.95 hard threshold
  await fire(handlers, ctx);
  assert.ok(readBlocks(stateFile).length >= 1, "block created on first fire at hard threshold");
});

test("e2e: auto-compress disabled → no enforcement blocks", async () => {
  const stateFile = "/tmp/pai-acp-auto-off.session.json";
  const { handlers, ctx } = setup({ modelContextLimit: LIMIT, compress: { autoCompress: false } }, stateFile);
  ctx.__setUsage(0.96 * LIMIT);
  for (let i = 0; i < 5; i++) await fire(handlers, ctx);
  assert.equal(readBlocks(stateFile).length, 0, "no blocks when autoCompress disabled");
});
