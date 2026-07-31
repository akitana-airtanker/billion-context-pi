import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { CoreMessage } from "acp-kernel";

type AgentMessage = SessionMessageEntry["message"];

type AnyMessage = {
  role?: string;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
};

const REF_TAG = /^\[m\d{5}\] /;

export function entriesToCoreMessages(entries: SessionEntry[]): CoreMessage[] {
  const out: CoreMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const cores = projectMessage(entry.message, entry.id);
    out.push(...cores);
  }
  return out;
}

function projectMessage(message: AgentMessage, id: string): CoreMessage[] {
  const msg = message as AnyMessage;
  const role = msg.role;
  if (role === "user") {
    return [{ id, role: "user", contentType: "text", text: extractText(msg.content) }];
  }
  if (role === "toolResult") {
    return [{
      id,
      role: "tool",
      contentType: "tool-result",
      toolName: msg.toolName,
      toolCallId: msg.toolCallId,
      text: extractText(msg.content),
    }];
  }
  if (role === "assistant") {
    const calls = allToolCalls(msg.content);
    if (calls.length > 0) {
      const textParts = extractText(msg.content);
      if (calls.length === 1) {
        const call = calls[0]!;
        const argStr = stringifyArgs(call.arguments);
        const text = argStr && textParts ? `${textParts}\n${argStr}` : argStr || textParts;
        return [{ id, role: "assistant", contentType: "tool-call", toolName: call.name, toolCallId: call.id, text }];
      }
      return calls.map((call) => {
        const argStr = stringifyArgs(call.arguments);
        return {
          id: `${id}#${call.id}`,
          role: "assistant" as const,
          contentType: "tool-call" as const,
          toolName: call.name,
          toolCallId: call.id,
          text: argStr || textParts,
        };
      });
    }
    return [{ id, role: "assistant", contentType: "text", text: extractText(msg.content) }];
  }
  const customText = extractText(msg.content);
  return customText.length > 0
    ? [{ id, role: "user", contentType: "text", text: customText }]
    : [];
}

function stringifyArgs(args: unknown): string {
  if (!args) return "";
  if (typeof args === "string") return args;
  return safeStringify(args);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.replace(REF_TAG, "");
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text.replace(REF_TAG, ""));
    }
  }
  return parts.join("\n");
}

function allToolCalls(content: unknown): { name: string; id: string; arguments?: unknown }[] {
  if (!Array.isArray(content)) return [];
  const calls: { name: string; id: string; arguments?: unknown }[] = [];
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string; arguments?: unknown };
    if (b.type === "toolCall" && b.name) calls.push({ name: b.name, id: b.id ?? "", arguments: b.arguments });
  }
  return calls;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function coreOutToAgentMessages(
  coreOut: CoreMessage[],
  originalById: Map<string, AgentMessage>,
): AgentMessage[] {
  return coreOut
    .filter((core) => !core.id.startsWith("acp_summary_"))
    .map((core) => {
      const original = originalById.get(core.id);
      if (original) return patchRefTag(original, core);
      return null;
    })
    .filter((m): m is AgentMessage => m !== null);
}

function patchRefTag(original: AgentMessage, core: CoreMessage): AgentMessage {
  const match = core.text ? core.text.match(REF_TAG) : null;
  const tag = match ? match[0] : null;
  if (!tag) return original;
  const base = original as AnyMessage;
  const rawBlocks = Array.isArray(base.content)
    ? base.content
    : typeof base.content === "string"
      ? [{ type: "text" as const, text: base.content }]
      : [];
  const peeled = peelRefTagBlocks(rawBlocks);
  return {
    ...(original as object),
    content: [{ type: "text", text: tag }, ...peeled],
  } as AgentMessage;
}

function peelRefTagBlocks(blocks: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const block of blocks) {
    const b = block as { type?: string; text?: string };
    if (b?.type === "text" && typeof b.text === "string") {
      const stripped = b.text.replace(REF_TAG, "");
      if (stripped.length > 0) out.push({ ...b, text: stripped });
    } else {
      out.push(block);
    }
  }
  return out;
}

function synthesize(core: CoreMessage): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: core.text ?? "" }],
    timestamp: Date.now(),
  } as AgentMessage;
}
