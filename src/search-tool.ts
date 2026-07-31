import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query — keywords to match in compressed block summaries." }),
  limit: Type.Optional(Type.Number({ description: "Max results to return (default: 10)." })),
});

type SearchArgs = Static<typeof SearchParams>;

export function makeSearchTool(runtime: AcpRuntime): ToolDefinition<typeof SearchParams> {
  return {
    name: "search_context",
    label: "Search Context",
    description:
      "Search compressed block summaries by keyword. Use BEFORE decompressing to find the right block. Returns matching blocks with relevance scores and previews.",
    promptSnippet: 'search_context({ query: "auth token" })',
    promptGuidelines: [
      "Search to find which block contains information you need before decompressing.",
      "Results show block ID, tier, topic, and a preview of the summary.",
    ],
    parameters: SearchParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const result = await handleSearch(params as SearchArgs, runtime, ctx);
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleSearch(args: SearchArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state } = await runtime.stateFor(ctx);
  const query = args.query.toLowerCase().trim();
  const limit = args.limit ?? 10;
  const terms = query.split(/\s+/).filter((t) => t.length > 0);

  const activeBlocks = state.blocks.filter((b) => b.active);
  if (activeBlocks.length === 0) return "No compressed blocks to search.";

  const scored = activeBlocks.map((block) => {
    const text = (block.summary || "").toLowerCase();
    const topic = (block.topic || "").toLowerCase();
    const haystack = topic + " " + text;
    let score = 0;
    for (const term of terms) {
      const matches = haystack.split(term).length - 1;
      score += matches;
    }
    return { block, score };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return `No matches for "${args.query}" in ${activeBlocks.length} block(s). Active blocks: ${activeBlocks.map((b) => b.blockId).join(", ")}.`;
  }

  const lines = [`Found ${scored.length} match(es) for "${args.query}":`];
  for (const { block, score } of scored.slice(0, limit)) {
    const preview = (block.summary || "").slice(0, 200);
    const tier = block.tier ?? 1;
    const topic = block.topic ?? "(no topic)";
    lines.push("");
    lines.push(`${block.blockId} (T${tier}, score:${score}) "${topic}"`);
    lines.push(`  ${preview}${block.summary.length > 200 ? "..." : ""}`);
  }
  if (scored.length > limit) lines.push("", `${limit} of ${scored.length} shown.`);
  return lines.join("\n");
}
