import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug } from "./log.js";
import { parseBlockIdArg, SUMMARY_HEADER } from "acp-kernel";
import type { CompressionBlock, CompressionState, CoreMessage } from "acp-kernel";

const DecompressParams = Type.Object({
  blockId: Type.String({ description: 'Block id to restore, e.g. "b5".' }),
  full: Type.Optional(Type.Boolean({ description: "If true, recurse through all nested blocks to original messages. Default: false (restores one tier up — nested block summaries shown, direct messages in full)." })),
});

type DecompressArgs = Static<typeof DecompressParams>;

export function makeDecompressTool(runtime: AcpRuntime): ToolDefinition<typeof DecompressParams> {
  return {
    name: "decompress",
    label: "Decompress",
    description:
      "Restore a previously compressed block's content as this tool's result (appended to the conversation). The block stays compressed — the visible context and cache prefix are not disrupted. By default restores one tier up (T2 shows T1 summaries). Use full:true for all original messages.",
    promptSnippet: 'decompress({ blockId: "b5" }) or decompress({ blockId: "b5", full: true })',
    promptGuidelines: [
      "Decompress when you need exact details lost in compression (file contents, error messages, signatures).",
      "Content is returned as the tool result — the compressed block stays folded, so context is not disrupted.",
      "Use full:true to recurse through all nested tiers to original messages.",
    ],
    parameters: DecompressParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const result = await handleDecompress(params as DecompressArgs, runtime, ctx);
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleDecompress(args: DecompressArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const blockId = parseBlockIdArg(args.blockId);
  if (!blockId) return `Invalid blockId: ${args.blockId}. Expected format like "b5" or "5".`;

  const { state, coreMessages } = await runtime.stateFor(ctx);
  const block = state.blocks.find((b) => b.blockId === blockId);
  if (!block) {
    const active = state.blocks.filter((b) => b.active).map((b) => b.blockId).join(", ");
    return `Block ${blockId} not found. Active blocks: ${active || "(none)"}.`;
  }

  const full = args.full ?? false;
  const { text, count } = collectRestoredContent(block, coreMessages, state, full);

  debug.event("decompress", { blockId, full, count });

  if (count === 0) return `Block ${blockId} has no restorable message content.`;
  return `Restored block ${blockId} (${count} item${count === 1 ? "" : "s"}):\n\n${text}`;
}

interface RestoredContent {
  text: string;
  count: number;
}

export function collectRestoredContent(
  block: CompressionBlock,
  coreMessages: CoreMessage[],
  state: CompressionState,
  full: boolean,
): RestoredContent {
  const targetIds = new Set(block.effectiveMessageIds);

  if (full) {
    const msgs = coreMessages.filter((m) => targetIds.has(m.id));
    if (msgs.length === 0) return { text: "", count: 0 };
    return { text: msgs.map(formatRestoredMessage).join("\n\n"), count: msgs.length };
  }

  // one tier up: messages covered by nested ACTIVE children stay folded (their
  // summaries are shown); the block's own direct messages are shown in full.
  const nestedChildren: CompressionBlock[] = [];
  const nestedCovered = new Set<string>();
  for (const childId of block.directBlockIds) {
    const child = state.blocks.find((b) => b.blockId === childId);
    if (!child?.active) continue;
    nestedChildren.push(child);
    for (const id of child.effectiveMessageIds) nestedCovered.add(id);
  }

  const parts: string[] = [];
  for (const child of nestedChildren) {
    const label = child.topic ? `${child.blockId}: ${child.topic}` : child.blockId;
    parts.push(`${SUMMARY_HEADER} — ${label}\n${child.summary}`);
  }

  let directCount = 0;
  for (const m of coreMessages) {
    if (targetIds.has(m.id) && !nestedCovered.has(m.id)) {
      parts.push(formatRestoredMessage(m));
      directCount++;
    }
  }

  const count = directCount + nestedChildren.length;
  if (count === 0) return { text: "", count: 0 };
  return { text: parts.join("\n\n"), count };
}

function formatRestoredMessage(message: CoreMessage): string {
  const text = message.text ?? "";
  if (message.toolName && message.contentType !== "text") {
    return `[${message.role} • ${message.toolName}]\n${text}`;
  }
  return `[${message.role}]\n${text}`;
}
