import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug } from "./log.js";
import { parseBlockIdArg, collectBlockContent } from "acp-kernel";
import { writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

const DecompressParams = Type.Object({
  blockId: Type.String({ description: 'Block id to restore, e.g. "b5".' }),
  full: Type.Optional(Type.Boolean({ description: "If true, recurse through all nested blocks to original messages. Default: false (restores one tier up — nested block summaries shown, direct messages in full)." })),
  toFile: Type.Optional(Type.String({ description: "If provided, write the restored content to this file path (must be under /tmp or ~/.cache/opencode) instead of returning it inline." })),
});

type DecompressArgs = Static<typeof DecompressParams>;

export function makeDecompressTool(runtime: AcpRuntime): ToolDefinition<typeof DecompressParams> {
  return {
    name: "decompress",
    label: "Decompress",
    description:
      "Restore a previously compressed block's content. The block stays compressed — context and cache prefix are not disrupted. By default returns content as this tool's result (appended to the conversation). Use toFile to write to a file instead. full:true recurses to original messages.",
    promptSnippet: 'decompress({ blockId: "b5" }) or decompress({ blockId: "b5", full: true }) or decompress({ blockId: "b5", toFile: "/tmp/restore.txt" })',
    promptGuidelines: [
      "Decompress when you need exact details lost in compression (file contents, error messages, signatures).",
      "Content is returned as the tool result — the compressed block stays folded, so context is not disrupted.",
      "Use toFile to write large restorations to a file (e.g. for reading back via read tool) instead of returning inline.",
      "Use full:true to recurse through all nested tiers to original messages.",
    ],
    parameters: DecompressParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const result = await handleDecompress(params as DecompressArgs, runtime, ctx);
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

function resolveToFilePath(targetPath: string): string | { error: string } {
  // Expand a leading ~ to the home dir so users can pass ~/.cache/...
  const expanded = targetPath.startsWith("~/")
    ? join(process.env.HOME ?? "", targetPath.slice(2))
    : targetPath;
  const resolved = resolve(expanded);
  const allowedDirs = [
    tmpdir(),
    join(process.env.HOME ?? "", ".cache", "opencode"),
  ];
  const isAllowed = allowedDirs.some((dir) => {
    const rel = relative(dir, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!isAllowed) {
    return { error: `Error: toFile path must be under ${tmpdir()} or ~/.cache/opencode/. Got: ${targetPath}` };
  }
  return resolved;
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

  if (count === 0) return `Block ${blockId} has no restorable message content.`;

  debug.event("decompress", { blockId, full, count, toFile: Boolean(args.toFile) });

  // toFile: write the collected content to a file. The block stays compressed;
  // nothing is appended to the conversation beyond a short confirmation.
  if (args.toFile) {
    const resolved = resolveToFilePath(args.toFile);
    if (typeof resolved === "object" && "error" in resolved) return resolved.error;
    await writeFile(resolved, text, "utf8");
    return `Wrote block ${blockId} (${count} item${count === 1 ? "" : "s"}) to ${resolved}`;
  }

  return `Restored block ${blockId} (${count} item${count === 1 ? "" : "s"}):\n\n${text}`;
}
