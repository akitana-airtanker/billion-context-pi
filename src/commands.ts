import type { ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import type { AcpRuntime } from "./runtime.js";
import { estimateTokens, collectCoveredMessageIds } from "./tokens.js";

type CommandOptions = Omit<RegisteredCommand, "name" | "sourceInfo">;

export function makeCommands(runtime: AcpRuntime): Array<{ name: string; options: CommandOptions }> {
  return [
    {
      name: "acp",
      options: {
        description: "Show ACP context usage and compression status.",
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-status",
      options: {
        description: "Detailed ACP status (block tiers, token breakdown).",
        handler: async (_args, ctx) => ctx.ui.notify(await statusReport(runtime, ctx)),
      },
    },
    {
      name: "acp-decompress",
      options: {
        description: "Restore a compressed block's summary. Usage: /acp-decompress b3",
        handler: async (args, ctx) => {
          const id = args.trim();
          if (!id) {
            ctx.ui.notify("Usage: /acp-decompress <blockId>");
            return;
          }
          const { state } = await runtime.stateFor(ctx);
          const block = runtime.core.decompress(id, state);
          ctx.ui.notify(block ? `[${id}] ${block.summary}` : `Block ${id} not found.`);
        },
      },
    },
    {
      name: "acp-search",
      options: {
        description: "Search compressed block summaries. Usage: /acp-search auth token",
        handler: async (args, ctx) => {
          const query = args.trim();
          if (!query) {
            ctx.ui.notify("Usage: /acp-search <query>");
            return;
          }
          const { state } = await runtime.stateFor(ctx);
          const hits = runtime.core.search(query, state);
          if (hits.length === 0) {
            ctx.ui.notify("No matching blocks.");
            return;
          }
          const lines = hits.map((b) => `[${b.blockId}] (t${b.tier}) ${b.topic ?? ""}`.trim());
          ctx.ui.notify(lines.join("\n"));
        },
      },
    },
  ];
}

async function statusReport(runtime: AcpRuntime, ctx: ExtensionCommandContext): Promise<string> {
  const { state, coreMessages } = await runtime.stateFor(ctx);
  const config = runtime.configFor(ctx);
  const coveredIds = collectCoveredMessageIds(state);
  const tokenCount = estimateTokens(coreMessages, coveredIds);
  const report = runtime.core.status(state, tokenCount, config);
  const pct = (report.contextUsage * 100).toFixed(0);
  return [
    `ACP — context ${pct}% (${tokenCount}/${config.modelContextLimit})`,
    `Blocks: ${report.activeBlocks} active / ${report.totalBlocks} total`,
    `Compressed so far: ~${report.tokensCompressed} tokens`,
  ].join("\n");
}
