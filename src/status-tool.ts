import { Type, type Static } from "typebox";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { buildStatusReport, defaultCountTokens } from "acp-kernel";

const StatusParams = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal("compressed"), Type.Literal("uncompressed")], { description: '"compressed" = drill into blocks; "uncompressed" = show visible messages/ranges. Default: overview.' })),
  view: Type.Optional(Type.Union([Type.Literal("ranges"), Type.Literal("messages")], { description: 'For uncompressed scope: "ranges" (default) or "messages" (per-message listing).' })),
  tool: Type.Optional(Type.String({ description: 'Filter by tool name (e.g. "bash", "read"). Only for uncompressed+messages.' })),
  sort: Type.Optional(Type.Union([Type.Literal("size"), Type.Literal("time"), Type.Literal("tool"), Type.Literal("age")], { description: "Sort order. Default: size." })),
  limit: Type.Optional(Type.Number({ description: "Max items to show (default: 30)." })),
});

type StatusArgs = Static<typeof StatusParams>;

export function makeStatusTool(runtime: AcpRuntime): ToolDefinition<typeof StatusParams> {
  return {
    name: "acp_status",
    label: "ACP Status",
    description:
      "Context status: overview, compressed blocks, or uncompressed ranges/messages. No args = overview + totals + compressible ranges. scope:'uncompressed' + view:'messages' for per-message listing. scope:'compressed' for block drilldown.",
    promptSnippet: 'acp_status({}) or acp_status({ scope: "uncompressed", view: "messages" })',
    promptGuidelines: [
      "Call with no args for a quick overview of context usage.",
      "Use scope:'uncompressed' to find the largest compressible ranges.",
      "Use scope:'compressed' to inspect existing compression blocks.",
    ],
    parameters: StatusParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
      const result = await handleStatus(params as StatusArgs, runtime, ctx);
      return { details: undefined, content: [{ type: "text", text: result }] };
    },
  };
}

async function handleStatus(args: StatusArgs, runtime: AcpRuntime, ctx: ExtensionContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);

  return buildStatusReport(state, coreMessages, defaultCountTokens, {
    scope: args.scope,
    view: args.view,
    tool: args.tool,
    sort: args.sort,
    limit: args.limit,
  });
}
