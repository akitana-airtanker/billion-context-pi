import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";
import { MAX_EMERGENCY_NUDGES_PER_TURN } from "../src/runtime.js";

// Regression (issue dog/billion-context-pi#7): in the emergency band (usage
// >= the emergency threshold) the nudge bypassed the per-turn dedup, so a long
// tool loop that stayed over the threshold re-nudged — and the model
// re-compressed — on EVERY LLM call (consecutive repeated compression, no cap
// per turn). Emergency nudges are now capped at MAX_EMERGENCY_NUDGES_PER_TURN
// per user turn; beyond the cap the kernel's automatic tool-output truncate
// and the overflow self-heal are the backstops.

const STATE_FILE = "/tmp/pai-acp-emergency-cap.session.json";

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

function msg(id: string, role: string, text: string) {
  return { type: "message", id, parentId: null, timestamp: "", message: { role, content: text, timestamp: Date.now() } };
}

const MID = "lorem ".repeat(3000);

let branchEntries: any[] = [];

function fakeCtx() {
  return {
    mode: "rpc" as const,
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 100_000 },
    cwd: "/tmp",
    sessionManager: {
      getBranch: () => branchEntries as any[],
      getSessionId: () => "emergency-cap",
      getSessionFile: () => STATE_FILE,
    },
    getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: 100_000 }),
  };
}

const fire = (handlers: Map<string, ((e: any, ctx: any) => any)[]>, entries: any[], ctx: any) =>
  handlers.get("context")![0]!({ type: "context", messages: entries.map((e) => e.message) }, ctx);

// pi's injected nudge text: "⚠️ Context limit reached — compress now. …"
const nudgeCount = (r: any) =>
  (r?.messages ?? []).filter((m: any) => m.role === "user" && /Context limit reached|compress/i.test(JSON.stringify(m.content))).length;

test("emergency nudge is capped at MAX_EMERGENCY_NUDGES_PER_TURN per user turn", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 100_000 })(api as any);

  // Sent view ~40 × ~4.5K ≈ 180K tokens → 180% of the 100K window: deep in the
  // emergency band, and it stays there across fires (no tool-result messages to
  // auto-truncate, no compression performed).
  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 39; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  branchEntries = entries;
  const ctx = fakeCtx();

  const perFire: number[] = [];
  for (let i = 0; i < MAX_EMERGENCY_NUDGES_PER_TURN + 2; i++) {
    const r = await fire(handlers, entries, ctx);
    perFire.push(nudgeCount(r));
  }

  // Fires 1..N inject the emergency nudge; fires N+1.. are suppressed by the cap.
  for (let i = 0; i < MAX_EMERGENCY_NUDGES_PER_TURN; i++) {
    assert.equal(perFire[i], 1, `fire ${i + 1} injects exactly one emergency nudge`);
  }
  for (let i = MAX_EMERGENCY_NUDGES_PER_TURN; i < perFire.length; i++) {
    assert.equal(perFire[i], 0, `fire ${i + 1} is suppressed (cap reached)`);
  }
  assert.equal(perFire.reduce((a, b) => a + b, 0), MAX_EMERGENCY_NUDGES_PER_TURN, "total injections equal the cap");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});

test("a new user turn resets the emergency nudge cap", async () => {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 100_000 })(api as any);

  const entries = [msg("e0", "user", "start " + MID)];
  for (let i = 1; i <= 39; i++) entries.push(msg(`e${i}`, i % 2 ? "assistant" : "user", `f${i} ` + MID));
  branchEntries = entries;
  const ctx = fakeCtx();

  // Exhaust the cap on the first turn.
  for (let i = 0; i < MAX_EMERGENCY_NUDGES_PER_TURN; i++) await fire(handlers, entries, ctx);
  const capped = await fire(handlers, entries, ctx);
  assert.equal(nudgeCount(capped), 0, "cap reached on the first turn");

  // A new user message starts a new turn (new turnKey) → the cap resets and the
  // emergency nudge reaches the model again.
  entries.push(msg("e40", "user", "next " + MID));
  branchEntries = entries;
  const newTurn = await fire(handlers, entries, ctx);
  assert.ok(nudgeCount(newTurn) >= 1, "emergency nudge fires again on the new turn");
  await rm(`${STATE_FILE}.acp.json`, { force: true });
});
