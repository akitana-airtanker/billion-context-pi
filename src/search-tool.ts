import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { searchBlocks } from "acp-kernel";
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
    const results = searchBlocks(state, args.query, { limit: args.limit });

    if (results.length === 0) {
        const count = state.blocks.filter((b) => b.active).length;
        return `No matches for "${args.query}" in ${count} block(s).`;
    }

    const lines = [`Found ${results.length} match(es) for "${args.query}":`];
    for (const r of results) {
        lines.push("", `${r.blockId} (T${r.tier}, score:${r.score}) "${r.topic}"`);
        const ellipsis = r.block.summary.length > r.preview.length ? "..." : "";
        lines.push(`  ${r.preview}${ellipsis}`);
    }
    return lines.join("\n");
}
