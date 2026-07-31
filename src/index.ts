import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import type { CoreMessage, NudgeDecision } from "acp-kernel";
import { renderNudgeText } from "acp-kernel";
import type { AdapterConfig } from "./config.js";
import { createRuntime, type AcpRuntime } from "./runtime.js";
import { makeCompressTool } from "./compress-tool.js";
import { makeCommands } from "./commands.js";
import { entriesToCoreMessages, coreOutToAgentMessages } from "./messages.js";
import { ACP_SYSTEM_PROMPT } from "./system-prompt.js";
import { debug } from "./log.js";
import { collectCoveredMessageIds, estimateTokens } from "./tokens.js";
import { checkForUpdate } from "./update.js";

type AgentMessage = SessionMessageEntry["message"];

export function createAcpExtension(adapter: AdapterConfig = {}): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const runtime = createRuntime(adapter);
    wireCompactionDisable(pi);
    wireSessionLifecycle(pi, runtime);
    wireContextTransform(pi, runtime);
    wireSystemPrompt(pi);
    pi.registerTool(makeCompressTool(runtime));
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
  pi.on("session_start", (_event, ctx) => {
    runtime.store.invalidate();
    void checkForUpdate((msg) => {
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
      const entries = ctx.sessionManager.buildContextEntries();
      const coreMessages = entriesToCoreMessages(entries);
      const state = await runtime.store.load(
        ctx.sessionManager.getSessionFile() ?? undefined,
        sid,
      );
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
    const out = turn.nudge?.shouldInject ? [...rebuilt, nudgeMessage(turn.nudge)] : rebuilt;

    // Always return the transformed array: every message needs its [mNNNNN] ref
    // tag applied, so there is no meaningful "no change" case to short-circuit.
      debug.event("context-out", { outMsgs: out.length, injected: turn.nudge?.shouldInject ?? false });
    if (turn.nudge?.shouldInject) {
      const rendered = renderNudgeText(turn.nudge);
      const lines = [rendered.text];
      const top = [...turn.nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
      if (top) {
        lines.push("", `Example: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })`);
      }
      debug.event("nudge-injected", { sid: ctx.sessionManager.getSessionId(), voice: rendered.voice, text: lines.join("\n") });
    }
    return { messages: out };
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

function nudgeMessage(nudge: NudgeDecision): AgentMessage {
  const rendered = renderNudgeText(nudge);
  const lines = [rendered.text];

  const top = [...nudge.compressibleRanges].sort((a, b) => b.tokens - a.tokens)[0];
  if (top) {
    lines.push("");
    lines.push(`Example: compress({ content: [{ startId: "${top.startRef}", endId: "${top.endRef}", summary: "..." }] })`);
  }

  return {
    role: "user",
    content: [{ type: "text", text: lines.join("\n") }],
    timestamp: Date.now(),
  } as AgentMessage;
}
