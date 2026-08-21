import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { createRuntime, MAX_COMPRESS_ATTEMPTS } from "../src/runtime.js";

// Issue #9 post-mortem (session 01a02542): after a successful compress pinned
// context at 22.6K, the model re-issued the BYTE-IDENTICAL no-op compress call
// 3,849 times over 5h13m. The kernel hides failed compress calls from the sent
// view (KEEP_LAST_ORPHANED=0), so the visible context reached a fixed point the
// deterministic model could never observe — each iteration ran the full
// stateFor/processTurn/save pipeline for nothing.
//
// Fixes under test:
//  1. Tool-side circuit breaker: once the turn burned MAX_COMPRESS_ATTEMPTS
//     failed/no-op attempts, re-submitting an EXACT already-failed range set is
//     refused without executing anything.
//  2. Post-cap STOP message: while the newest outcome is still a failure, every
//     context fire re-injects a count-bearing stop instruction — visible in
//     headless mode and varying per new failure, so the sent view never sits at
//     a fixed point again.
//  3. Failure outcomes carry the parsed ranges of their compress call (from
//     the assistant toolCall block), keyed by toolCallId.

function captureApi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const api = {
    on(event: string, handler: (e: any, ctx: any) => any) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    tools: [] as any[],
    commands: new Map<string, any>(),
    registerTool(tool: any) { this.tools.push(tool); },
    registerCommand(name: string, options: any) { this.commands.set(name, options); },
  };
  return { api, handlers };
}

function userMsg(id: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role: "user", content: text, timestamp: Date.now() } };
}

function compressCallMsg(id: string, toolCallId: string, ranges: Array<{ startId: string; endId: string }>) {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: {
      role: "assistant",
      content: [{
        type: "toolCall", id: toolCallId, name: "compress",
        arguments: { content: ranges.map((r) => ({ startId: r.startId, endId: r.endId, summary: "s" })) },
      }],
      timestamp: Date.now(),
    },
  };
}

function toolResultMsg(id: string, toolCallId: string, text: string, isError: boolean) {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: {
      role: "toolResult", toolCallId, toolName: "compress",
      content: [{ type: "text", text }], isError, timestamp: Date.now(),
    },
  };
}

const NOOP_PANEL = "▣ ACP | 58.5K → 58.5K tokens (~0 reclaimed, 0 blocks)\nErrors: range m00001..m00001: Requested range(s) already compressed; nothing to compress";
const SUCCESS_PANEL = "▣ ACP | 58.5K → 5.7K tokens (~52.8K reclaimed, 4 blocks)";

function fakeCtx(getEntries: () => any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => getEntries(),
      getSessionId: () => "breaker-test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

const stopMsgs = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Compress circuit breaker OPEN/.test(JSON.stringify(m.content)));

const retryMsgs = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /compress call FAILED/.test(JSON.stringify(m.content)));

const ZH = "中".repeat(6000);

// ─── unit: spec-keyed breaker state ─────────────────────────────────────────

test("compressSpecBlocked: exact re-submission refused only after cap, different ranges pass, resets", () => {
  const rt = createRuntime({});
  const R1 = [{ startId: "m00748", endId: "m00771" }];
  const R2 = [{ startId: "m00900", endId: "m00910" }];
  const fail = (id: string, ranges: typeof R1) => ({ toolCallId: id, isError: true, success: false, noop: false, ranges });

  for (let i = 0; i < MAX_COMPRESS_ATTEMPTS; i++) {
    rt.noteCompressOutcomes("u1", [fail(`t${i}`, R1)]);
  }
  assert.equal(rt.compressFailCountFor("u1"), MAX_COMPRESS_ATTEMPTS);
  assert.equal(rt.compressSpecBlocked("u1", R1), true, "exact re-submission of a failed range set is refused");
  assert.equal(rt.compressSpecBlocked("u1", R2), false, "a NEW range set is still allowed at cap");
  assert.equal(rt.compressSpecBlocked("u2", R1), false, "other turns are unaffected");

  rt.noteCompressOutcomes("u1", [{ toolCallId: "ts", isError: false, success: true, noop: false }]);
  assert.equal(rt.compressSpecBlocked("u1", R1), false, "success lifts the cap and clears recorded specs");

  rt.noteCompressOutcomes("u2", [fail("x0", R1)]);
  assert.equal(rt.compressSpecBlocked("u2", R1), false, "below cap the breaker stays closed");
});

// ─── integration: tool refuses the 4th identical no-op ──────────────────────

test("the compress tool refuses a byte-identical re-submission after the cap burned (issue #9)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-breaker-tool.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  const R1 = [{ startId: "m00001", endId: "m00001" }];
  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx); // assigns refs, fresh state

  for (let i = 1; i <= MAX_COMPRESS_ATTEMPTS; i++) {
    entries = [...entries, compressCallMsg(`ea${i}`, `call_${i}`, R1), toolResultMsg(`er${i}`, `call_${i}`, NOOP_PANEL, false)];
  }
  const rCap = await fire(handlers, ctx);
  assert.equal(retryMsgs(rCap).length, 0, "retry prompts capped");

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await assert.rejects(
    () => compressTool.execute("call_4", { content: R1.map((r) => ({ ...r, summary: "identical retry" })) }, undefined, undefined, ctx),
    /Compress circuit breaker OPEN[\s\S]*m00001\.\.m00001[\s\S]*already failed/,
    "4th identical call is refused without executing",
  );

  const out = await compressTool.execute(
    "call_5",
    { content: [{ startId: "m00002", endId: "m00002", summary: "different ranges still run" }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.ok(!/circuit breaker/.test(text), `different ranges must not hit the breaker: ${text}`);
  await rm(`${stateFile}.acp.json`, { force: true });
});

// ─── integration: post-cap STOP message ─────────────────────────────────────

test("post-cap STOP message re-injects with rising count until a success (breaks the fixed point)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-breaker-stop.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  const R1 = [{ startId: "m00001", endId: "m00001" }];
  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  entries = [...entries, compressCallMsg("ea1", "call_1", R1), toolResultMsg("er1", "call_1", NOOP_PANEL, false)];
  const r1 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r1).length, 1, "first no-op → corrective retry nudge");
  assert.equal(stopMsgs(r1).length, 0, "no STOP message below cap");

  entries = [...entries, compressCallMsg("ea2", "call_2", R1), toolResultMsg("er2", "call_2", NOOP_PANEL, false)];
  entries = [...entries, compressCallMsg("ea3", "call_3", R1), toolResultMsg("er3", "call_3", NOOP_PANEL, false)];
  const r3 = await fire(handlers, ctx);
  assert.equal(stopMsgs(r3).length, 1, "cap burned → STOP message injected");
  assert.match(JSON.stringify(stopMsgs(r3)[0].content), /3 failed\/no-op compress calls/);

  const rAgain = await fire(handlers, ctx);
  assert.equal(stopMsgs(rAgain).length, 1, "STOP message re-injects on every fire while unaddressed (no fixed point)");

  entries = [...entries, compressCallMsg("ea4", "call_4", R1), toolResultMsg("er4", "call_4", NOOP_PANEL, false)];
  const r4 = await fire(handlers, ctx);
  assert.match(JSON.stringify(stopMsgs(r4)[0].content), /4 failed\/no-op compress calls/, "count rises per new failure");

  entries = [...entries, toolResultMsg("er5", "call_5", SUCCESS_PANEL, false)];
  const r5 = await fire(handlers, ctx);
  assert.equal(stopMsgs(r5).length, 0, "a genuine success closes the breaker");
  await rm(`${stateFile}.acp.json`, { force: true });
});
