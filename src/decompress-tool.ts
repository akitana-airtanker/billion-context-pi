import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug } from "./log.js";
import { parseBlockIdArg, deactivateBlock, buildRestoredContentPreview } from "acp-kernel";
import { writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

const DecompressParams = Type.Object({
  blockId: Type.String({ description: 'Block id to restore, e.g. "b5".' }),
  full: Type.Optional(Type.Boolean({ description: "If true, also deactivate all nested (consumed) blocks — restores all the way to original messages. Default: false (restores one tier up)." })),
  toFile: Type.Optional(Type.String({ description: "If provided, write the restored content to this file path (must be under /tmp or ~/.cache/opencode) instead of inflating context." })),
});

type DecompressArgs = Static<typeof DecompressParams>;

export function makeDecompressTool(runtime: AcpRuntime): ToolDefinition<typeof DecompressParams> {
  return {
    name: "decompress",
    label: "Decompress",
    description:
      "Restore a previously compressed block's content. By default restores one tier up (T2 shows T1 summaries). Use full:true to restore all the way to original messages.",
    promptSnippet: 'decompress({ blockId: "b5" }) or decompress({ blockId: "b5", full: true })',
    promptGuidelines: [
      "Decompress when you need exact details lost in compression (file contents, error messages, signatures).",
      "Decompressing inflates context — only do it when the summary is insufficient.",
      "Blocks from the same batch (same runId) are restored together.",
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

function collectBlockText(coreMessages: { id?: string; text?: string }[], msgIds: Set<string>): string {
  const lines: string[] = [];
  for (const m of coreMessages) {
    if (m.id && msgIds.has(m.id) && m.text) lines.push(m.text);
  }
  return lines.length > 0 ? lines.join("\n\n---\n\n") : "(no content available)";
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
  if (!block.active) return `Block ${blockId} is already inactive.`;

  const beforeActiveIds = new Set(block.effectiveMessageIds);

  // toFile: write restored content to a file instead of deactivating the
  // block (which would inflate context). Collects the same messages that
  // would become visible, writes them to the requested path, and leaves
  // context untouched.
  if (args.toFile) {
    const resolved = resolveToFilePath(args.toFile);
    if (typeof resolved !== "string") return resolved.error;
    const content = collectBlockText(coreMessages, beforeActiveIds);
    await writeFile(resolved, content, "utf8");
    debug.event("decompress-to-file", { blockId, path: resolved, bytes: content.length });
    return `Wrote block ${blockId} content (${content.length} bytes) to ${resolved}. Context not inflated.`;
  }

  const newState = deactivateBlock(state, [blockId], { deep: args.full ?? false });
  await runtime.save(newState, ctx);

  const { preview, restoredCount } = buildRestoredContentPreview(coreMessages, beforeActiveIds, newState);

  debug.event("decompress", { blockId, full: args.full ?? false, restoredCount });

  const lines = [`Restored block ${blockId}: ${restoredCount} message(s) now visible.`];
  if (preview) lines.push("", "Preview (truncated):", preview);
  return lines.join("\n");
}
