/**
 * Minimal i18n for user-facing slash-command output (descriptions, /acp and
 * /acp-decompress / /acp-search results, the /acp status report).
 *
 * Machine-facing text (tool descriptions, system prompts, nudge reports
 * injected to the model) is deliberately NOT localized here — translating
 * model-facing instructions risks degrading compression/nudge quality.
 *
 * `language` is resolved once per process: an explicit acp.json override
 * wins, otherwise the system LANG/LC_ALL env is inspected. The locale is a
 * process-global cache so command handlers and descriptions stay consistent
 * within a session.
 */
export type Locale = "en" | "zh";

export function detectLocale(): Locale {
  const raw = process.env.LC_ALL ?? process.env.LANG ?? "";
  return /^zh/i.test(raw) ? "zh" : "en";
}

const zh = {
  "acp.description": "显示 ACP 上下文占用、Token 构成与压缩状态。",
  "acp-status.description": "ACP 详细状态（压缩块层级、Token 构成、委派用量）。",
  "acp-decompress.description": "恢复压缩块内容（显示在会话中，块保持折叠）。用法: /acp-decompress b3",
  "acp-search.description": "搜索压缩块摘要。用法: /acp-search auth token",
  "decompress.usage": "用法: /acp-decompress <blockId>（例如 \"b3\"）",
  "decompress.not-found": "块 {id} 未找到。",
  "decompress.empty": "块 {id} 没有可恢复的消息内容。",
  "decompress.result": "块 {id}（{count} 条消息）:\n\n{text}",
  "search.usage": "用法: /acp-search <查询词>",
  "search.no-match": "没有匹配的块。",
  "context": "上下文: {pct}% ({used} / {limit})",
  "growth": "较上次提示增长: +{growth}",
  "breakdown": "Token 构成:",
  "nudge.active": "提示: 活跃{tier} — {reason}",
  "nudge.idle": "提示: 空闲 — {reason}",
  "blocks.active": "压缩块: {active} 活跃 / {total} 总计（已压缩 {tokens} tokens）",
  "blocks.none": "压缩块: 无（尚未压缩任何内容）",
  "tag-visibility": "标签可见性: 仅注入 LLM（深拷贝），不写入会话，不在终端显示。",
} as const;

const en: Record<keyof typeof zh, string> = {
  "acp.description": "Show ACP context usage, token breakdown, and compression status.",
  "acp-status.description": "Detailed ACP status (block tiers, token breakdown, delegate usage).",
  "acp-decompress.description": "Restore a compressed block's content (shown here, block stays folded). Usage: /acp-decompress b3",
  "acp-search.description": "Search compressed block summaries. Usage: /acp-search auth token",
  "decompress.usage": 'Usage: /acp-decompress <blockId> (e.g. "b3")',
  "decompress.not-found": "Block {id} not found.",
  "decompress.empty": "Block {id} has no restorable message content.",
  "decompress.result": "Block {id} ({count} items):\n\n{text}",
  "search.usage": "Usage: /acp-search <query>",
  "search.no-match": "No matching blocks.",
  "context": "Context: {pct}% ({used} / {limit})",
  "growth": "Growth: +{growth} since last nudge",
  "breakdown": "Token Breakdown:",
  "nudge.active": "Nudge: ACTIVE{tier} — {reason}",
  "nudge.idle": "Nudge: idle — {reason}",
  "blocks.active": "Blocks: {active} active / {total} total ({tokens} tokens compressed)",
  "blocks.none": "Blocks: none (nothing compressed yet)",
  "tag-visibility": "Tag visibility: tags injected to LLM only (deep copy), not persisted in session, not shown in terminal.",
};

let cached: Locale | null = null;

/** Resolve locale once per process (LANG/LC_ALL don't change mid-session). */
export function locale(): Locale {
  if (!cached) cached = detectLocale();
  return cached;
}

/** Override locale from user config (acp.json "language"); null resets to LANG detection. */
export function setLocale(lang: string | undefined): void {
  cached = lang === "zh" || lang === "en" ? lang : null;
}

/** Translate a key, substituting {name} placeholders. Falls back to English. */
export function t(key: keyof typeof zh, params?: Record<string, string | number>): string {
  const table: Record<string, string> = locale() === "zh" ? zh : en;
  let out = table[key] ?? en[key];
  if (params) {
    for (const [name, value] of Object.entries(params)) out = out.replaceAll(`{${name}}`, String(value));
  }
  return out;
}
