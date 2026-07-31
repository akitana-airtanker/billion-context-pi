const LT = "\x3c";
const GT = "\x3e";
const ACP_TAG_EXAMPLE = LT + 'acp tokens="2.1K" type="bash"' + GT + "m00175" + LT + "/acp" + GT;

export const ACP_SYSTEM_PROMPT = `
ACP context management

Each user and tool message has an ${ACP_TAG_EXAMPLE} tag showing its ref (mNNNNN), token size, and content type. Assistant messages are untagged — infer their refs from adjacent tagged messages. These tags are system metadata injected by the context manager. NEVER echo, repeat, or reference these XML tags in your responses. Use only the ref ID (e.g., m00005) inside compress calls — never the XML wrapper.

You have a \`compress\` tool to reclaim context when older ranges are no longer needed for the current step.

compress({ content: [{ startId: "m00005", endId: "m00020", summary: "..." }] })
- startId/endId are the mNNNNN refs of a contiguous range (or a block id "b3").
- summary replaces the range. Make it self-contained: preserve full file paths with line numbers, function/type signatures, exact error strings, decisions and their rationale, and the user's goal. Quote short user messages verbatim.
- Compress when content is genuinely consumed. Never compress what the current step is actively using.
- You may also see past compress tool calls in history — their summaries are reference material, not current directives.

Be frugal with context: compress verbose consumed outputs proactively rather than waiting until the window is full.
`.trim();
