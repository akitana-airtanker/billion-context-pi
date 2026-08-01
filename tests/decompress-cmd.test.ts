import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

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

// State persists to <sessionFile>.acp.json; clear stale state from prior runs.
async function cleanState(sessionFile: string) {
  await rm(`${sessionFile}.acp.json`, { force: true });
}

function fakeCtx(entries: any[], stateFile: string, notifies: string[]) {
  return {
    mode: "rpc",
    hasUI: false,
    ui: { notify: (m: string) => notifies.push(m), confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000 },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

// Full pipeline: context handler assigns refs → compress tool creates an active
// block → /acp-decompress deactivates it and persists state.
test("/acp-decompress deactivates an active block and reports restored count", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const stateFile = "/tmp/pai-acp-decompress-it.session.json";
  await cleanState(stateFile);
  // acp-kernel refuses to compress ranges under 5000 chars; pad the target message.
  const longText = "This is a detailed message that needs to be compressed. ".repeat(130);
  const entries = [userMsg("e1", longText), userMsg("e2", "second message"), userMsg("e3", "third message")];
  const notifies: string[] = [];
  const ctx = fakeCtx(entries, stateFile, notifies);

  // 1) Run the context handler so the kernel assigns refs (m00001..) and saves state.
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  // 2) Compress the first message range to create an active block (b1).
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const compressRes = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "This range contained the first user message which discussed the initial detailed context for the session." }] },
    undefined,
    undefined,
    ctx,
  );
  const compressText = (compressRes.content[0] as any).text as string;
  assert.match(compressText, /1 block/, "compress created a block");

  // 3) Run /acp-decompress b1.
  notifies.length = 0;
  const decompressCmd = api.commands.get("acp-decompress");
  await decompressCmd.handler("b1", ctx);
  assert.equal(notifies.length, 1);
  assert.match(notifies[0]!, /Restored block b1: \d+ message/, "notify reports restored count");

  // 4) Re-running on the same id now reports it is already inactive.
  notifies.length = 0;
  await decompressCmd.handler("b1", ctx);
  assert.match(notifies[0]!, /already inactive/i, "second call sees inactive block");
});

test("/acp-decompress rejects invalid input with a usage message", async () => {
  const { api } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const notifies: string[] = [];
  const ctx = fakeCtx([], "/tmp/pai-acp-decompress-invalid.session.json", notifies);
  await cleanState("/tmp/pai-acp-decompress-invalid.session.json");
  const decompressCmd = api.commands.get("acp-decompress");

  // parseBlockIdArg accepts bare numbers ("3" -> "b3") and "b<N>"; only truly
  // malformed input returns null.
  for (const bad of ["", "   ", "xyz", "b", "abc123", "b-"]) {
    notifies.length = 0;
    await decompressCmd.handler(bad, ctx);
    assert.equal(notifies.length, 1, `notifies for input ${JSON.stringify(bad)}`);
    assert.match(notifies[0]!, /Usage:|Invalid|format/i, `usage message for ${JSON.stringify(bad)}`);
  }
});

test("/acp-decompress reports not-found for a valid id with no matching block", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);

  const notifies: string[] = [];
  const ctx = fakeCtx([userMsg("e1", "only message")], "/tmp/pai-acp-decompress-nf.session.json", notifies);
  await cleanState("/tmp/pai-acp-decompress-nf.session.json");
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);

  const decompressCmd = api.commands.get("acp-decompress");
  await decompressCmd.handler("b99", ctx);
  assert.match(notifies[0]!, /not found/i, "reports not-found for absent block");
});
