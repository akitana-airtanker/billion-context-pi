import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { Value } from "typebox/value";
import { createAcpExtension } from "../src/index.js";

const STATE_FILE = "/tmp/pai-acp-blockids-it.session.json";

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

async function cleanState() {
  await rm(`${STATE_FILE}.acp.json`, { force: true });
}

function fakeCtx(entries: any[]) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => STATE_FILE,
    },
  };
}

async function fireCtx(handlers: Map<string, ((event: any, ctx: any) => any)[]>, ctx: any) {
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
}

async function setup(entries: any[]) {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const ctx = fakeCtx(entries);
  await fireCtx(handlers, ctx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  return { compressTool, ctx, handlers };
}

function resultText(res: any): string {
  return (res.content[0] as any).text as string;
}

const big = (n: string) => `detailed message ${n} ` + "x".repeat(3000);

test("schema accepts a blockIds-only content entry (startId/endId now optional)", async () => {
  await cleanState();
  const { compressTool } = await setup([userMsg("e1", "hi")]);
  const params = compressTool.parameters;
  assert.ok(
    Value.Check(params, { content: [{ blockIds: ["b1", "b2"], summary: "distilled summary of the two blocks" }] }),
    "blockIds-only entry should validate (startId/endId optional)",
  );
  assert.ok(
    Value.Check(params, { content: [{ startId: "m00001", endId: "m00002", summary: "range summary covering the early messages" }] }),
    "classic startId/endId entry should still validate",
  );
});

test("compress blockIds distills specific non-contiguous blocks into a higher tier", async () => {
  await cleanState();
  const entries = [
    userMsg("e1", big("one")), userMsg("e2", big("two")),
    userMsg("e3", big("three")),
    userMsg("e4", big("four")), userMsg("e5", big("five")),
    userMsg("e6", big("six")), userMsg("e7", big("seven")), userMsg("e8", big("eight")),
    userMsg("e9", big("nine")), userMsg("e10", big("ten")), userMsg("e11", big("eleven")), userMsg("e12", big("twelve")),
  ];
  const { compressTool, ctx } = await setup(entries);

  await compressTool.execute("tc1", { content: [{ startId: "m00001", endId: "m00002", summary: "Block one: early setup and initialization of the test session harness." }] }, undefined, undefined, ctx);
  await compressTool.execute("tc2", { content: [{ startId: "m00004", endId: "m00005", summary: "Block two: configuration work and parameter tuning for the pipeline." }] }, undefined, undefined, ctx);

  const res = await compressTool.execute("tc3", { content: [{ blockIds: ["b1", "b2"], summary: "Distilled tier-2 summary combining blocks one and two into a higher tier." }] }, undefined, undefined, ctx);
  const text = resultText(res);
  assert.match(text, /\d+ block/, "blockIds distillation should create a higher-tier block");
  assert.doesNotMatch(text, /error/i, "blockIds distillation should not error");
});
