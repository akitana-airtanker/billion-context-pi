import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { createRuntime, MAX_EMERGENCY_NUDGES_PER_TURN } from "../src/runtime.js";
import { lastUserMessageId } from "../src/tokens.js";

// Transient-injection governance (post-mortem for #223 + #6, unified ledger):
// pi rebuilds the sent context on every LLM call, so any transient injection
// re-appends per fire unless budgeted. #223 happened because the retry
// prompt's budget counted DISTINCT FAILED CALLS instead of INJECTIONS;
// #6 happened because the emergency nudge had no budget a no-op-looping
// model could reach. The ledger inverts that: budgets count INJECTIONS per
// GENUINE user turn (1 for normal nudges, MAX_EMERGENCY_NUDGES_PER_TURN for
// emergency), and NOTHING the model does (ignore, fail, no-op, neutral) can
// extend them — only a genuine user turn resets.
//
// Behavior under test:
//  1. compress-tool accepts a JSON-encoded string for content (root cause of
//     session 01a00a38) and THROWS on garbage (isError:true).
//  2. Failed compress toolResults persist in the session log; NO transient
//     retry prompt is ever injected (#223 regression).
//  3. Emergency nudges are bounded by INJECTIONS per turn regardless of the
//     model's response mix (#6 + the neutral/no-response escape hatches).
//  4. Synthetic user messages (throttle kicks, delegate notifications) do
//     NOT reset budgets; genuine user input does.

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

function toolResultMsg(id: string, toolCallId: string, text: string, isError: boolean) {
  return {
    type: "message", id, parentId: null, timestamp: "",
    message: {
      role: "toolResult", toolCallId, toolName: "compress",
      content: [{ type: "text", text }], isError, timestamp: Date.now(),
    },
  };
}

// Simulates pi's thrown-validation toolResult shape (what a failed compress
// call looks like in entries — whether thrown by pi-ai validation or by
// handleCompress's own argument checks).
const VALIDATION_ERR = 'Validation failed for tool "compress":\n  - content.0: must be object\n\nReceived arguments:\n{"content":"[{\\"topic\\":\\"x\\"}]"}';
const NOOP_PANEL = "▣ ACP | 58.5K → 58.5K tokens (~0 reclaimed, 0 blocks)\nErrors: range m00001..m00002: Requested range(s) already compressed; nothing to compress";
const NEUTRAL_TEXT = "No ranges provided.";
const KICK_TEXT = "[ACP:provider-throttle] The previous assistant response was interrupted by a provider rate limit.";
const DELEGATE_TEXT = "[acp_delegate done] ** researcher ** (runId `r1`, exit 0) result follows";

function fakeCtx(getEntries: () => any[], stateFile: string) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => null,
    sessionManager: {
      buildContextEntries: () => getEntries(),
      getSessionId: () => "retry-test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

const retryMsgs = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /compress call FAILED/.test(JSON.stringify(m.content)));

const ZH = "中".repeat(6000);

// ─── unit: the injection ledger ─────────────────────────────────────────────

test("noteInjection: counts injections, denies without incrementing, resets on genuine turn, exhaustion is one-shot", () => {
  const rt = createRuntime({});

  let r = rt.noteInjection("u1", "nudge", 1);
  assert.deepEqual(r, { allowed: true, count: 1, exhaustedNow: true }, "budget 1 → allowed once, exhausted edge fires");
  r = rt.noteInjection("u1", "nudge", 1);
  assert.equal(r.allowed, false, "denied after budget");
  assert.equal(r.count, 1, "denied calls do not increment");

  r = rt.noteInjection("u1", "emergency", MAX_EMERGENCY_NUDGES_PER_TURN);
  assert.equal(r.allowed, true);
  assert.equal(r.exhaustedNow, false, "kinds are independent budgets");
  r = rt.noteInjection("u1", "emergency", MAX_EMERGENCY_NUDGES_PER_TURN);
  assert.equal(r.count, 2);
  assert.equal(r.exhaustedNow, false);
  r = rt.noteInjection("u1", "emergency", MAX_EMERGENCY_NUDGES_PER_TURN);
  assert.deepEqual(r, { allowed: true, count: MAX_EMERGENCY_NUDGES_PER_TURN, exhaustedNow: true }, "third emergency reaches the cap");
  r = rt.noteInjection("u1", "emergency", MAX_EMERGENCY_NUDGES_PER_TURN);
  assert.equal(r.allowed, false);

  // turn rollover resets every kind at once
  r = rt.noteInjection("u2", "emergency", MAX_EMERGENCY_NUDGES_PER_TURN);
  assert.deepEqual(r, { allowed: true, count: 1, exhaustedNow: false }, "new genuine turn → fresh budgets");
  // rolling back to an OLD turn key is also a rollover (fresh state)
  r = rt.noteInjection("u1", "emergency", MAX_EMERGENCY_NUDGES_PER_TURN);
  assert.equal(r.count, 1, "returning to a previous turn key still resets");

  rt.clearInjectionLedger();
  r = rt.noteInjection("u1", "emergency", MAX_EMERGENCY_NUDGES_PER_TURN);
  assert.equal(r.count, 1, "session_start clears the ledger");
});

test("lastUserMessageId skips synthetic machinery messages (throttle kicks, delegate notifications)", () => {
  const entries = [
    userMsg("u1", "genuine question"),
    userMsg("k1", KICK_TEXT),
    userMsg("d1", DELEGATE_TEXT),
  ];
  assert.equal(lastUserMessageId(entries as any), "u1", "synthetic users do not rotate the turn key");
  const withGenuine = [...entries, userMsg("u2", "next real question")];
  assert.equal(lastUserMessageId(withGenuine as any), "u2");
  assert.equal(lastUserMessageId([userMsg("only", KICK_TEXT)] as any), undefined, "all-synthetic → no genuine turn yet");
});

// ─── unit: normalizeRanges via the tool ─────────────────────────────────────

test("compress tool accepts JSON-encoded string content (non-strict-tool providers)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-str.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx); // assigns refs

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    // exactly what session 01a00a38's model sent: a JSON-encoded array string
    { content: JSON.stringify([{ startId: "m00001", endId: "m00001", summary: "compressed from string form" }]) },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.ok(/ACP \|/.test(text), `expected success panel: ${text}`);
  await rm(`${stateFile}.acp.json`, { force: true });
});

test("compress tool THROWS on garbage string content (isError:true so the failure persists)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-str2.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  await fire(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  // pi-agent-core marks only THROWN tool errors isError:true; returning the
  // error string would be isError:false and silently success-shaped.
  await assert.rejects(
    () => compressTool.execute("tc1", { content: "not json {" }, undefined, undefined, ctx),
    /Invalid compress content[\s\S]*ARRAY/,
  );
  await rm(`${stateFile}.acp.json`, { force: true });
});

// ─── integration: no transient retry prompt (#223) ──────────────────────────

test("failed compress toolResults never inject a transient retry prompt; the error itself persists in context (#223)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-it1.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  let entries: any[] = [userMsg("e1", ZH)];
  const ctx = fakeCtx(() => entries, stateFile);
  const r0 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r0).length, 0, "no failures yet → no retry prompt");

  entries = [...entries, toolResultMsg("e2", "call_1", VALIDATION_ERR, true)];
  const r1 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r1).length, 0, "failure → NO transient retry prompt");
  assert.ok(
    JSON.stringify(r1.messages).includes("must be object"),
    "the failed toolResult itself flows to the model (self-correction signal)",
  );

  // re-fire (streaming/tool loop fires context repeatedly): still nothing —
  // the pre-#223 fix re-injected on every fire (~400/hour when never retried)
  const r2 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r2).length, 0, "re-fire injects nothing");

  entries = [...entries, toolResultMsg("e3", "call_2", VALIDATION_ERR, true)];
  entries = [...entries, toolResultMsg("e4", "call_3", VALIDATION_ERR, true)];
  const r3 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r3).length, 0, "cap reached → still no prompt ever");

  // later turns stay silent too
  entries = [...entries, userMsg("e5", "next question")];
  for (let i = 0; i < 3; i++) {
    const r = await fire(handlers, ctx);
    assert.equal(retryMsgs(r).length, 0, `new turn fire ${i + 1}: nothing`);
  }
  entries = [...entries, toolResultMsg("e6", "call_9", VALIDATION_ERR, true)];
  const r6 = await fire(handlers, ctx);
  assert.equal(retryMsgs(r6).length, 0, "fresh failure in a new turn → no prompt");
  await rm(`${stateFile}.acp.json`, { force: true });
});

// ─── integration: emergency budget is bounded by injections (#6 + escapes) ──

test("emergency nudge injects at most MAX_EMERGENCY_NUDGES_PER_TURN per turn, regardless of the model's response mix", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 180_000 })(api as any);
  const stateFile = "/tmp/pai-acp-retry-emerg.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });

  // ~270K tokens of sent view vs a 180K window → kernel goes EMERGENCY and
  // the nudge wants to re-inject on every context fire.
  const MID = "lorem ".repeat(3000);
  const roleMsg = (id: string, role: string, text: string) => ({
    type: "message", id, parentId: null, timestamp: "",
    message: { role, content: text, timestamp: Date.now() },
  });
  let entries: any[] = [roleMsg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 59; i++) entries.push(roleMsg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  const ctx = fakeCtx(() => entries, stateFile);
  const nudgeCount = (r: any) =>
    (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached/.test(JSON.stringify(m.content))).length;

  let injected = 0;
  // adversarial loop: alternate every response shape the old budgets could
  // not reach — hard failures, no-op panels, neutral "No ranges provided.",
  // and plain silence (no compress result at all)
  const responses = [
    () => toolResultMsg("ea", "call_a", VALIDATION_ERR, true),
    () => toolResultMsg("eb", "call_b", NOOP_PANEL, false),
    () => toolResultMsg("ec", "call_c", NEUTRAL_TEXT, false),
    () => null,
  ];
  for (let i = 0; i < 20; i++) {
    const r = await fire(handlers, ctx);
    injected += nudgeCount(r);
    assert.ok(nudgeCount(r) <= 1, "at most one injection per fire");
    const mk = responses[i % responses.length]!;
    const msg = mk();
    if (msg) entries = [...entries, msg];
  }
  assert.equal(injected, MAX_EMERGENCY_NUDGES_PER_TURN, `exactly the budget across 20 fires (got ${injected})`);

  // synthetic machinery messages must NOT re-arm the budget…
  entries = [...entries, userMsg("ek", KICK_TEXT)];
  let r = await fire(handlers, ctx);
  assert.equal(nudgeCount(r), 0, "throttle kick does not reset the emergency budget");
  entries = [...entries, userMsg("ed", DELEGATE_TEXT)];
  r = await fire(handlers, ctx);
  assert.equal(nudgeCount(r), 0, "delegate notification does not reset the emergency budget");

  // …but a genuine user message does
  entries = [...entries, userMsg("e99", "actual next question")];
  r = await fire(handlers, ctx);
  assert.equal(nudgeCount(r), 1, "genuine user turn → fresh emergency budget");
  await rm(`${stateFile}.acp.json`, { force: true });
});
