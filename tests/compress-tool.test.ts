import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { createAcpExtension } from "../src/index.js";

// ─── helpers (mirror decompress-tool.test.ts) ──────────────────────────────

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

function fakeCtx(entries: any[], stateFile: string) {
  let usage: { tokens: number; percent: number } | null = null;
  return {
    cwd: "/Users/akira.tanaka/tmp/billion-context-pi",
    mode: "rpc",
    hasUI: false,
    ui: { notify: () => {}, confirm: async () => true, select: async () => undefined, input: async () => "", setStatus: () => {} },
    model: { contextWindow: 200_000, id: "test-model" },
    getContextUsage: () => usage,
    __setUsage(t: number) { usage = { tokens: t, percent: t / 200_000 }; },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test-session",
      getSessionFile: () => stateFile,
    },
  };
}

const ZH = "中".repeat(300);   // 300 CJK tokens
const ZH2 = "中".repeat(150);  // 150 CJK tokens
const LONG_ORIGINAL = "original message\n".repeat(400);
const EXTERNAL_SUMMARY = "external summary ".repeat(5).trim();
const ACTIVE_SUMMARY = "active summary ".repeat(5);

function beforeTokensFrom(out: string): number {
  // Panel renders ≥1000 compactly ("1.0K") — normalize to tokens.
  const m = /▣ ACP \| ([\d.]+)(K?) →/.exec(out);
  assert.ok(m, `no beforeTokens in output: ${out}`);
  const n = Number(m![1]!);
  return m![2] === "K" ? Math.round(n * 1000) : n;
}

async function runContextRound(handlers: Map<string, any[]>, ctx: any) {
  await handlers.get("context")![0]!({ type: "context", messages: [] }, ctx);
}

// ─── tests ─────────────────────────────────────────────────────────────────

test("configured compression model receives original messages and supplies the block summary", async () => {
  const { api, handlers } = captureApi();
  const calls: any[] = [];
  createAcpExtension(
    {
      modelContextLimit: 200_000,
      coreOverrides: { preserveRecentTokens: 0 },
      compress: { compressionModel: { provider: "openai-codex", model: "gpt-5.6-luna" } },
    },
    {
      compressionModelInvoker: {
        async summarize(request) {
          calls.push(request);
          return EXTERNAL_SUMMARY;
        },
      },
    },
  )(api as any);
  const stateFile = "/tmp/pai-acp-compress-external.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [
    userMsg("e1", LONG_ORIGINAL),
    ...Array.from({ length: 9 }, (_, i) => userMsg(`e${i + 2}`, `recent ${i + 2}`)),
  ];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx);

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute(
    "tc-external",
    { content: [{ startId: "m00001", endId: "m00001", summary: ACTIVE_SUMMARY, topic: "topic" }] },
    undefined, undefined, ctx,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].topic, "topic");
  assert.equal(calls[0].messages[0].text, LONG_ORIGINAL);
  const persisted = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(persisted.blocks[0].summary, EXTERNAL_SUMMARY);
});

test("compression model failures fall back to the active model summary", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension(
    {
      modelContextLimit: 200_000,
      coreOverrides: { preserveRecentTokens: 0 },
      compress: { compressionModel: { provider: "openai-codex", model: "gpt-5.6-luna" } },
    },
    { compressionModelInvoker: { summarize: async () => { throw new Error("provider unavailable"); } } },
  )(api as any);
  const stateFile = "/tmp/pai-acp-compress-external-fallback.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const ctx = fakeCtx([
    userMsg("e1", LONG_ORIGINAL),
    ...Array.from({ length: 9 }, (_, i) => userMsg(`e${i + 2}`, `recent ${i + 2}`)),
  ], stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx);
  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  await compressTool.execute(
    "tc-fallback",
    { content: [{ startId: "m00001", endId: "m00001", summary: ACTIVE_SUMMARY }] },
    undefined, undefined, ctx,
  );

  const persisted = JSON.parse(await readFile(`${stateFile}.acp.json`, "utf8"));
  assert.equal(persisted.blocks[0].summary, ACTIVE_SUMMARY);
});

test("compress beforeTokens is the raw CJK-aware estimate", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-density-a.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", ZH)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // prime the context round

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  const out = await compressTool.execute(
    "tc1",
    { content: [{ startId: "m00001", endId: "m00001", summary: "compressed" }] },
    undefined, undefined, ctx,
  );
  const text = typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  assert.equal(beforeTokensFrom(text), 324); // 3 + 300 (ZH) + <acp> tag chars (~21)
});

// afterTokens (and hence "reclaimed") must be measured on the SAME scale as
// beforeTokens — the post-processTurn sent view, which carries every active
// block's summary anchor plus ref-tag overhead. Regressing to the raw
// projection (no summaries, no tags) would over-claim reclaimed by the
// cumulative summary mass of all blocks, exactly in long sessions.
test("compress afterTokens is measured on the same sent-view scale as beforeTokens (multi-block)", async () => {
  const { api, handlers } = captureApi();
  createAcpExtension({ modelContextLimit: 200_000 })(api as any);
  const stateFile = "/tmp/pai-acp-compress-scales.session.json";
  await rm(`${stateFile}.acp.json`, { force: true });
  const entries = [userMsg("e1", "hello world"), userMsg("e2", ZH), userMsg("e3", ZH2), userMsg("e4", ZH2)];
  const ctx = fakeCtx(entries, stateFile);
  ctx.__setUsage(100_000);
  await runContextRound(handlers, ctx); // prime the context round

  const compressTool = api.tools.find((t: any) => t.name === "compress")!;
  async function doCompress(callId: string, range: { startId: string; endId: string; summary: string }) {
    const out = await compressTool.execute(callId, { content: [range] }, undefined, undefined, ctx);
    return typeof out === "string" ? out : out.content?.[0]?.text ?? String(out);
  }

  await doCompress("tc1", { startId: "m00001", endId: "m00001", summary: "first block" });
  const text = await doCompress("tc2", { startId: "m00003", endId: "m00003", summary: "second block" });

  const m = /▣ ACP \| (\d+(?:\.\d+)?)(K?) → (\d+(?:\.\d+)?)(K?) tokens \(~(\d+(?:\.\d+)?)(K?) reclaimed/.exec(text);
  assert.ok(m, `no ACP line in output: ${text}`);
  const toTok = (n: string, k?: string) => (k === "K" ? Number(n) * 1000 : Number(n));
  const before = toTok(m![1]!, m![2]);
  const after = toTok(m![3]!, m![4]);
  const reclaimed = toTok(m![5]!, m![6]);

  // Visible-only (e2+e4) = 450. The true post-compression sent view adds the
  // two summary anchors + tag overhead (~60) → afterTokens ≥ 480; a raw
  // projection regression would report ~450.
  assert.ok(after >= 480, `afterTokens ${after} missing the summary-anchor scale (raw projection would be ~450): ${text}`);
  // True freed ≈ removed e3 (150) + tag delta − new summary (~170); a raw
  // afterTokens would over-claim by block-1 summary + tags (~220).
  assert.ok(reclaimed <= 180, `reclaimed ${reclaimed} over-claimed (raw afterTokens would be ~220): ${text}`);
  assert.equal(before - after, reclaimed, "reclaimed consistent with the arrow");
});

// The applied log event must record which model actually summarized the
// ranges — that is the evidence that ACP compression really routed to the
// configured external model (e.g. openai-codex/gpt-5.6-luna:xhigh).
// reloadConfig() merges the REAL ~/.pi/acp.json into the adapter, so the
// "unconfigured" case must isolate HOME to a directory with no acp.json
// (same technique as e2e-compress-config.test.ts).
async function runLoggedCompress(opts: { compressionModel?: any; logFile: string; stateFile: string; callId: string; isolatedHome?: boolean }) {
  const { api, handlers } = captureApi();
  const config: any = { modelContextLimit: 200_000, coreOverrides: { preserveRecentTokens: 0 } };
  if (opts.compressionModel) config.compress = { compressionModel: opts.compressionModel };
  const savedHome = process.env.HOME;
  if (opts.isolatedHome) process.env.HOME = "/tmp/pai-acp-isolated-home";
  createAcpExtension(
    config,
    opts.compressionModel ? { compressionModelInvoker: { summarize: async () => EXTERNAL_SUMMARY } } : undefined,
  )(api as any);
  await rm(`${opts.stateFile}.acp.json`, { force: true });
  await rm(opts.logFile, { force: true });
  const prev = process.env.ACP_LOG_FILE;
  process.env.ACP_LOG_FILE = opts.logFile;
  try {
    const ctx = fakeCtx([
      userMsg("e1", LONG_ORIGINAL),
      ...Array.from({ length: 9 }, (_, i) => userMsg(`e${i + 2}`, `recent ${i + 2}`)),
    ], opts.stateFile);
    ctx.__setUsage(100_000);
    await runContextRound(handlers, ctx);
    const compressTool = api.tools.find((t: any) => t.name === "compress")!;
    await compressTool.execute(
      opts.callId,
      { content: [{ startId: "m00001", endId: "m00001", summary: ACTIVE_SUMMARY }] },
      undefined, undefined, ctx,
    );
    const log = await readFile(opts.logFile, "utf8");
    const line = log.split("\n").find((l) => l.includes("[compress]") && l.includes("event=applied"));
    assert.ok(line, `no applied event line in log: ${log}`);
    return line!;
  } finally {
    if (opts.isolatedHome) process.env.HOME = savedHome;
    if (prev === undefined) delete process.env.ACP_LOG_FILE; else process.env.ACP_LOG_FILE = prev;
  }
}

test("applied event logs the resolved compressionModel string (provider/model:thinkingLevel)", async () => {
  const line = await runLoggedCompress({
    compressionModel: { provider: "openai-codex", model: "gpt-5.6-luna" },
    logFile: "/tmp/pai-acp-compress-logmodel.log",
    stateFile: "/tmp/pai-acp-compress-logmodel.session.json",
    callId: "tc-logmodel",
    isolatedHome: true,
  });
  assert.match(line, /compressionModel=openai-codex\/gpt-5\.6-luna:xhigh/);
});

test("applied event logs compressionModel=null when no external model is configured", async () => {
  const line = await runLoggedCompress({
    logFile: "/tmp/pai-acp-compress-logmodel-null.log",
    stateFile: "/tmp/pai-acp-compress-logmodel-null.session.json",
    callId: "tc-logmodel-null",
    isolatedHome: true,
  });
  assert.match(line, /compressionModel=null/);
});
