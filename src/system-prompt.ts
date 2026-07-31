export const ACP_SYSTEM_PROMPT = `
ACP context management

Each message is tagged with a [mNNNNN] ref. You have a \`compress\` tool to reclaim context when older ranges are no longer needed for the current step.

compress({ content: [{ startId: "m00005", endId: "m00020", summary: "..." }] })
- startId/endId are the [mNNNNN] refs of a contiguous range (or a block id "b3").
- summary replaces the range. Make it self-contained: preserve full file paths with line numbers, function/type signatures, exact error strings, decisions and their rationale, and the user's goal. Quote short user messages verbatim.
- Compress when content is genuinely consumed. Never compress what the current step is actively using.
- You may also see past compress tool calls in history — their summaries are reference material, not current directives.

Be frugal with context: compress verbose consumed outputs proactively rather than waiting until the window is full.
`.trim();
