import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { debug } from "./log.js";
import { parseBlockIdArg, collectBlockContent } from "acp-kernel";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

/** Directory for auto-generated decompress output files. */
const AUTO_DIR = join(process.env.HOME ?? tmpdir(), ".cache", "pi", "acp-decompress");

/** Maximum chars of a head preview included in the tool result for file mode. */
const PREVIEW_CHARS = 600;

const DecompressParams = Type.Object({
  blockId: Type.String({ description: 'Block id to restore, e.g. "b5". Also accepts a message ref (UUID) from search_context results — resolves to the owning block automatically.' }),
  full: Type.Optional(Type.Boolean({ description: "If true, recurse through all nested blocks to original messages. Default: false (restores one tier up — nested block summaries shown, direct messages in full)." })),
  toFile: Type.Optional(Type.String({ description: "Write restored content to this file path (must be under /tmp, ~/.cache/opencode, or ~/.cache/pi) instead of the default auto-generated path. Block stays compressed." })),
  inline: Type.Optional(Type.Boolean({ description: "If true, return content inline as this tool's result (appends to context). Default: false — content is written to an auto-generated file to avoid context bloat. Only set true when the content is small or you accept the context cost." })),
});

type DecompressArgs = Static<typeof DecompressParams>;

export function makeDecompressTool(runtime: AcpRuntime): ToolDefinition<typeof DecompressParams> {
  return {
    name: "decompress",
    label: "Decompress",
    description:
      "Restore a previously compressed block's content. The block stays compressed — context and cache prefix are not disrupted. By default writes content to an auto-generated file (avoids context bloat) and returns the path; use the read tool to access it. Pass inline:true to return content in the tool result instead. full:true recurses to original messages. Accepts a block id (b5) or a message ref (UUID) from search_context results.",
    promptSnippet: 'decompress({ blockId: "b5" }) or decompress({ blockId: "d51b6f94" }) (message ref from search) — writes to file by default; add inline: true to return inline',
    promptGuidelines: [
      "Decompress when you need exact details lost in compression (file contents, error messages, signatures).",
      "You can pass a block id (b5) OR a message ref (UUID) from search_context results — it resolves to the owning block.",
      "By default content is written to an auto-generated file — use the read tool to view it. This keeps context small.",
      "Pass inline:true ONLY when content is small or you accept the context cost.",
      "Use full:true to recurse through all nested tiers to original messages.",
    ],
    parameters: DecompressParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const result = await handleDecompress(params as DecompressArgs, runtime, ctx);
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

/** Allowed roots for toFile paths. Keeps user-supplied paths from escaping to
 *  arbitrary filesystem locations. */
const ALLOWED_DIRS = [
  tmpdir(),
  join(process.env.HOME ?? "", ".cache", "opencode"),
  join(process.env.HOME ?? "", ".cache", "pi"),
];

function resolveToFilePath(targetPath: string): string | { error: string } {
  const expanded = targetPath.startsWith("~/")
    ? join(process.env.HOME ?? "", targetPath.slice(2))
    : targetPath;
  const resolved = resolve(expanded);
  const isAllowed = ALLOWED_DIRS.some((dir) => {
    const rel = relative(dir, resolved);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!isAllowed) {
    return { error: `Error: toFile path must be under ${tmpdir()}, ~/.cache/opencode, or ~/.cache/pi. Got: ${targetPath}` };
  }
  return resolved;
}

/** Generate a unique auto file path for a block. Uses a timestamp so repeated
 *  decompressions of the same block never overwrite each other. */
function autoFilePath(blockId: string): string {
  // blockId already carries the "b" prefix (e.g. "b5"); use it as-is so the
  // filename reads "b5-<ts>.txt" rather than "bb5-<ts>.txt".
  return join(AUTO_DIR, `${blockId}-${Date.now()}.txt`);
}

function headPreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  return text.slice(0, PREVIEW_CHARS) + "\n\n... (truncated; use read tool for full content)";
}

async function handleDecompress(args: DecompressArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);

  let blockId = parseBlockIdArg(args.blockId);
  // If not a valid blockId format, try resolving as a message ref (UUID from
  // search_context results) → the owning block.
  if (!blockId) {
    const msgRef = args.blockId.trim();
    const owner = state.blocks.find((b) => b.effectiveMessageIds.includes(msgRef));
    if (owner) blockId = owner.blockId;
  }
  if (!blockId) return `Invalid blockId: ${args.blockId}. Expected format like "b5", "5", or a message ref (UUID) from search_context results.`;
  const block = state.blocks.find((b) => b.blockId === blockId);
  if (!block) {
    const active = state.blocks.filter((b) => b.active).map((b) => b.blockId).join(", ");
    return `Block ${blockId} not found. Active blocks: ${active || "(none)"}.`;
  }

  const full = args.full ?? false;
  const { text, count } = collectBlockContent(state, block, coreMessages, { full });

  if (count === 0) return `Block ${blockId} has no restorable message content.`;

  // inline mode: return content directly. Model explicitly accepts the context
  // cost (e.g. small restorations or when it must reason over exact text).
  if (args.inline === true && !args.toFile) {
    debug.event("decompress", { blockId, full, count, mode: "inline" });
    return `Restored block ${blockId} (${count} item${count === 1 ? "" : "s"}) inline:\n\n${text}`;
  }

  // file mode (default): write to disk. Determined path is either the explicit
  // toFile or an auto-generated location. The block stays compressed; only a
  // short path + preview is added to the conversation.
  const targetPath = args.toFile
    ? resolveToFilePath(args.toFile)
    : autoFilePath(blockId);
  if (typeof targetPath === "object" && "error" in targetPath) return targetPath.error;

  await mkdir(AUTO_DIR, { recursive: true }).catch(() => {});
  await writeFile(targetPath, text, "utf8");

  debug.event("decompress", { blockId, full, count, mode: "file", path: targetPath, chars: text.length });

  const itemWord = count === 1 ? "item" : "items";
  const lines = [
    `Block ${blockId} (${count} ${itemWord}, ${text.length} chars) written to ${targetPath}.`,
    "Block stays compressed — context unchanged. Use the read tool to access the content.",
  ];
  // A short head preview lets the model decide whether the content is worth
  // reading without forcing a second round-trip for small restorations.
  lines.push("", "Preview:", headPreview(text));
  return lines.join("\n");
}
