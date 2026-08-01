import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { CoreMessage, NudgeDecision, CompressionBlock } from "acp-kernel";
import { renderNudgeText } from "acp-kernel";
import type { AdapterConfig } from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool } from "./compress-tool.js";
import { makeDecompressTool } from "./decompress-tool.js";
import { makeSearchTool } from "./search-tool.js";
import { makeStatusTool } from "./status-tool.js";
import { makeCommands } from "./commands.js";
import { coreOutToAgentMessages } from "./messages.js";
import { ACP_SYSTEM_PROMPT } from "./system-prompt.js";
import { debug, setDebugEnabled } from "./log.js";
import { collectCoveredMessageIds, estimateTokens } from "./tokens.js";
import { checkForUpdate } from "./update.js";
import { loadUserConfig, applyUserConfig } from "./user-config.js";

type AgentMessage = SessionMessageEntry["message"];

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const runtime = createRuntime(adapter);
    wireCompactionDisable(pi);
    wireSessionLifecycle(pi, runtime);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi);
    pi.registerTool(makeCompressTool(runtime));
    pi.registerTool(makeDecompressTool(runtime));
    pi.registerTool(makeSearchTool(runtime));
    pi.registerTool(makeStatusTool(runtime));
    for (const { name, options } of makeCommands(runtime)) {
      pi.registerCommand(name, options);
    }
  };
}

export default createAcpExtension();

// ACP owns compression; cancel Pi's built-in auto-compaction entirely (mirrors
// opencode-acp requiring opencode's compaction.auto = false).
function wireCompactionDisable(pi: ExtensionAPI): void {
  pi.on("session_before_compact", () => ({ cancel: true }));
}

function wireSessionLifecycle(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("session_start", async (_event, ctx) => {
    runtime.store.invalidate();
    // Load user config (~/.pi/acp.json + project .pi/acp.json) and apply it so
    // debug/terminalNudge/autoUpdate/modelContextLimit are runtime-configurable
    // without env vars or reinstalling.
    try {
      const user = await loadUserConfig(ctx.cwd);
      runtime.setAdapter(applyUserConfig(runtime.adapter, user));
      if (runtime.adapter.debug === true) setDebugEnabled(true);
    } catch {
      // best-effort — fall back to factory/env config
    }
    void checkForUpdate(runtime.adapter.autoUpdate ?? true, (msg) => {
      if (ctx.hasUI) ctx.ui.notify(msg);
    });
  });
}

// The core integration: Pi's `context` event fires before every LLM call with the
// messages about to be sent. We run acp-kernel's processTurn (prune + ref-tag +
// nudge decision) and return the transformed AgentMessage[].
function wireContextTransform(pi: ExtensionAPI, runtime: AcpRuntime): void {
  pi.on("context", async (event, ctx) => {
    const sid = ctx.sessionManager.getSessionId();
    const release = await runtime.acquireLock(sid);
    try {
      const { state, coreMessages, entries } = await runtime.stateFor(ctx);
      const config = runtime.configFor(ctx);
      const coveredIds = collectCoveredMessageIds(state);
      const tokenCount = estimateTokens(coreMessages, coveredIds);

      debug.event("context-in", {
        sid,
        eventMsgs: event.messages?.length ?? 0,
        entries: entries.length,
        coreMsgs: coreMessages.length,
        tokenCount,
        limit: config.modelContextLimit,
        blocksBefore: state.blocks.length,
        activeBefore: state.blocks.filter((b) => b.active).length,
      });

      const turn = runtime.core.processTurn({ messages: coreMessages, state, config, tokenCount });
      await runtime.save(turn.state, ctx);

      debug.event("processTurn", {
        outMsgs: turn.messages.length,
        summaryMsgs: turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        prunedMsgs: coreMessages.length - turn.messages.length + turn.messages.filter((m) => m.id.startsWith("acp_summary")).length,
        nudgeShouldInject: turn.nudge?.shouldInject ?? false,
        nudgeReason: turn.nudge?.reason ?? null,
        nudgeVoice: turn.nudge ? renderNudgeText(turn.nudge).voice : null,
      nudgePct: turn.nudge ? Math.round(turn.nudge.contextUsage * 100) : null,
      nudgeTier: turn.nudge?.tier ?? null,
      nudgeCompressibleCount: turn.nudge?.compressibleRanges.length ?? 0,
      nudgeProtectedCount: turn.nudge?.protectedRanges?.length ?? 0,
      nothingToCompress: turn.nudge?.reason?.includes("nothing to compress") ?? false,
      blocksAfter: turn.state.blocks.length,
      activeAfter: turn.state.blocks.filter((b) => b.active).length,
    });

    const originalById = collectOriginals(entries);
    const rebuilt = coreOutToAgentMessages(turn.messages, originalById);
    const terminalNudge = runtime.adapter.terminalNudge ?? true;

    if (turn.nudge?.shouldInject) {
      const rendered = renderNudgeText(turn.nudge);
      const lines = [rendered.text];
      const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
      if (top) {
        lines.push("", `Example: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })`);
      }
      const text = lines.join("\n");
      if (terminalNudge) {
        // Print to the user terminal only — the model never sees this. Mirrors
        // opencode-acp's ignored-part injection: surface the nudge without
        // spending model context on it.
        if (ctx.hasUI) ctx.ui.notify(text);
      } else {
        // Legacy: inject as a context message the model can act on.
        rebuilt.push(nudgeMessage(turn.nudge, turn.state.blocks.filter((b) => b.active)));
      }
      debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, channel: terminalNudge ? "terminal" : "context", text });
    }

    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
    debug.event("context-out", { outMsgs: rebuilt.length, injected: turn.nudge?.shouldInject ?? false, channel: turn.nudge?.shouldInject ? (terminalNudge ? "terminal" : "context") : "none" });
    return { messages: rebuilt };
    } finally {
      release();
    }
  });
}

function wireSystemPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${ACP_SYSTEM_PROMPT}`,
  }));
}

function collectOriginals(entries: ReturnType<ExtensionContext["sessionManager"]["buildContextEntries"]>): Map<string, AgentMessage> {
  const map = new Map<string, AgentMessage>();
  for (const entry of entries) {
    if (entry.type === "message") map.set(entry.id, entry.message);
  }
  return map;
}

function nudgeMessage(nudge: NudgeDecision, blocks: CompressionBlock[]): AgentMessage {
  const rendered = renderNudgeText(nudge);
  const lines = [rendered.text];

  if (blocks.length > 0) {
    const totalSummary = blocks.reduce((s, b) => s + Math.ceil((b.summary || "").length / 4), 0);
    const totalCompressed = blocks.reduce((s, b) => s + (b.compressedTokens || 0), 0);
    const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);
    const tierCounts: Record<number, number> = {};
    for (const b of blocks) {
      const t = b.tier ?? 1;
      tierCounts[t] = (tierCounts[t] || 0) + 1;
    }
    const tierStr = Object.keys(tierCounts).map(Number).sort().map((t) => `T${t}:${tierCounts[t]}`).join(" ");
    const ids = blocks.slice(0, 10).map((b) => b.blockId).join(", ");
    const extra = blocks.length > 10 ? ` (+${blocks.length - 10} more)` : "";
    lines.push("");
    lines.push(`Compressed blocks: ${blocks.length} active (${tierStr}) — ${fmt(totalSummary)} summary, ${fmt(totalCompressed)} original compressed. Blocks: ${ids}${extra}.`);
  }

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
