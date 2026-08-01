import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug } from "./log.js";
import { parseBlockIdArg, collectBlockContent } from "acp-kernel";

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
  const { text, count } = collectBlockContent(state, block, coreMessages, { full });

  debug.event("decompress", { blockId, full, count });

  if (count === 0) return `Block ${blockId} has no restorable message content.`;
  return `Restored block ${blockId} (${count} item${count === 1 ? "" : "s"}):\n\n${text}`;
}
