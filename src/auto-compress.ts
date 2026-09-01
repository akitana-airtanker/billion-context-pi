import type {
  CompressionCore,
  CompressRangeSpec,
  CompressibleRange,
  CoreMessage,
  CompressionState,
  Config,
  ProcessTurnResult,
  NudgeDecision,
  MessageRefMap,
} from "acp-kernel";
import { refToIndex, viableRanges } from "acp-kernel";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { debug, logInfo, logWarn } from "./log.js";

/** Server-side enforcement settings (issue #269). When the model keeps ignoring
 *  over-limit compression nudges, ACP auto-compresses the largest compressible
 *  ranges itself (heuristic summary, no model) so context stays bounded instead
 *  of climbing to 95%+ and overflowing. Percentage fields accept a ratio (0.95)
 *  or a percent string ("95%"). */
export interface AutoCompressConfig {
  /** Master switch. Default: true (this is the bug fix). Set `false` to restore
   *  the advisory-only behavior. */
  enabled?: boolean;
  /** Consecutive over-limit context events (each nudged, none compressed)
   *  before enforcement fires. Default: 3. */
  afterIgnores?: number;
  /** Usage ratio at which enforcement fires immediately, without waiting for
   *  `afterIgnores`. Accepts a ratio (0.95) or percent string ("95%").
   *  Default: 0.95. */
  hardThreshold?: number | string;
  /** Usage ratio enforcement tries to bring context below before stopping.
   *  Accepts a ratio (0.80) or percent string ("80%"). Default: 0.80. */
  targetPct?: number | string;
  /** Max ranges compressed in a single enforcement pass. Default: 5. */
  maxRanges?: number;
}

export interface AutoCompressSettings {
  enabled: boolean;
  afterIgnores: number;
  hardThreshold: number;
  targetPct: number;
  maxRanges: number;
}

export const AUTO_COMPRESS_DEFAULTS: AutoCompressSettings = {
  enabled: true,
  afterIgnores: 3,
  hardThreshold: 0.95,
  targetPct: 0.80,
  maxRanges: 5,
};

function parsePct(v: number | string): number {
  if (typeof v === "number") return v;
  const s = v.trim();
  if (s.endsWith("%")) return Number(s.slice(0, -1)) / 100;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Resolve enforcement settings from the (optional) `compress.autoCompress`
 *  field. `false` disables; `true`/undefined → defaults; object → per-field
 *  merge over defaults. */
export function resolveAutoCompress(compress?: { autoCompress?: boolean | AutoCompressConfig }): AutoCompressSettings {
  const ac = compress?.autoCompress;
  if (ac === false) return { ...AUTO_COMPRESS_DEFAULTS, enabled: false };
  if (typeof ac === "object" && ac !== null) {
    return {
      enabled: ac.enabled !== false,
      afterIgnores: ac.afterIgnores ?? AUTO_COMPRESS_DEFAULTS.afterIgnores,
      hardThreshold: ac.hardThreshold !== undefined ? parsePct(ac.hardThreshold) : AUTO_COMPRESS_DEFAULTS.hardThreshold,
      targetPct: ac.targetPct !== undefined ? parsePct(ac.targetPct) : AUTO_COMPRESS_DEFAULTS.targetPct,
      maxRanges: ac.maxRanges ?? AUTO_COMPRESS_DEFAULTS.maxRanges,
    };
  }
  return { ...AUTO_COMPRESS_DEFAULTS };
}

/** Per-session enforcement episode: how many consecutive over-limit nudges the
 *  model has ignored, plus the last turnKey that was auto-compressed (prevents
 *  re-firing within the same user turn). */
export class AutoCompressEpisode {
  streak = 0;
  lastAutoCompressedTurnKey: string | null = null;
  reset(): void {
    this.streak = 0;
    this.lastAutoCompressedTurnKey = null;
  }
}

/** Structural runtime surface maybeAutoCompress needs — satisfied by AcpRuntime
 *  (src/runtime.ts) without importing it (avoids a cycle). */
export interface AutoCompressRuntime {
  core: CompressionCore;
  save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
  autoCompressFor(sid: string): AutoCompressEpisode;
}

/** Pick the largest viable compressible ranges, greedily, until the projected
 *  usage drops below `settings.targetPct` (or `settings.maxRanges` is hit).
 *  Caller guarantees usage > targetPct before invoking, so the first (largest)
 *  range is always worth taking. */
export function pickAutoRanges(
  nudge: NudgeDecision | undefined,
  usage: number,
  limit: number,
  settings: AutoCompressSettings,
): CompressibleRange[] {
  if (!nudge) return [];
  const sorted = viableRanges(nudge.compressibleRanges).sort((a, b) => b.tokens - a.tokens);
  const picked: CompressibleRange[] = [];
  let projected = usage;
  for (const r of sorted) {
    if (picked.length >= settings.maxRanges) break;
    picked.push(r);
    if (limit > 0) projected -= r.tokens / limit;
    if (projected < settings.targetPct) break;
  }
  return picked;
}

/** The raw CoreMessages whose refs fall in [startRef, endRef] (inclusive),
 *  used to build the heuristic summary. */
export function messagesInRange(
  coreMessages: CoreMessage[],
  refMap: MessageRefMap,
  startRef: string,
  endRef: string,
): CoreMessage[] {
  const startIdx = refToIndex(startRef);
  const endIdx = refToIndex(endRef);
  if (startIdx === null || endIdx === null) return [];
  const out: CoreMessage[] = [];
  for (const m of coreMessages) {
    const ref = refMap.byRaw[m.id];
    if (!ref) continue;
    const idx = refToIndex(ref);
    if (idx !== null && idx >= startIdx && idx <= endIdx) out.push(m);
  }
  return out;
}

const AUTO_TOPIC = "Auto-compressed (enforcement)";
const SNIPPET_CHARS = 200;
const SUMMARY_MAX_CHARS = 12_000;

function summarizeOne(m: CoreMessage): string {
  const text = (m.text ?? "").replace(/\s+/g, " ").trim();
  const snippet = text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text;
  const label =
    m.contentType === "tool-call" ? `tool-call ${m.toolName ?? "?"}`
    : m.contentType === "tool-result" ? `tool-result ${m.toolName ?? "?"}`
    : m.contentType === "reasoning" ? "reasoning"
    : m.role;
  return `[${label}] ${snippet}`;
}

/** Mechanical, honest summary for an enforcement pass: no model wrote it, so it
 *  is a truncated per-message index that points at decompress for the full
 *  original content (the block's effectiveMessageIds allow a full restore). */
export function buildHeuristicSummary(messages: CoreMessage[], startRef: string, endRef: string): string {
  const lines: string[] = [
    "AUTO-COMPRESSED by ACP enforcement: the model ignored repeated compression nudges, so this range was compressed mechanically (no model-written summary). The lines below are a truncated index of each message; call decompress to restore the full original content if you need details.",
    `Range ${startRef}..${endRef} — ${messages.length} message(s):`,
  ];
  for (const m of messages) lines.push(`- ${summarizeOne(m)}`);
  let out = lines.join("\n");
  if (out.length > SUMMARY_MAX_CHARS) out = `${out.slice(0, SUMMARY_MAX_CHARS)}\n…[summary truncated]`;
  return out;
}

export interface AutoCompressInput {
  runtime: AutoCompressRuntime;
  ctx: ExtensionContext;
  config: Config;
  coreMessages: CoreMessage[];
  turn: ProcessTurnResult;
  tokenCount: number;
  turnKey: string;
  sid: string;
  settings: AutoCompressSettings;
  compressOutcomes: ReadonlyArray<{ success: boolean }>;
}

export interface AutoCompressOutcome {
  turn: ProcessTurnResult;
  blocksCreated: number;
  tokensCompressed: number;
  usageBefore: number;
  reason: "hard" | "streak";
}

/** Server-side enforcement (issue #269). Fires when the model has ignored
 *  `settings.afterIgnores` consecutive over-limit nudges, or immediately at
 *  `settings.hardThreshold` usage. Compresses the largest viable ranges with a
 *  heuristic summary, persists, re-runs processTurn, and returns the fresh turn
 *  so the caller can rebuild + inject the nudge from post-compression state.
 *  Returns null when nothing should (or could) be compressed. */
export async function maybeAutoCompress(input: AutoCompressInput): Promise<AutoCompressOutcome | null> {
  const { runtime, ctx, config, coreMessages, turn, tokenCount, turnKey, sid, settings, compressOutcomes } = input;
  const ep = runtime.autoCompressFor(sid);
  const limit = config.modelContextLimit;
  const usage = limit > 0 ? tokenCount / limit : 0;
  const overLimit =
    turn.nudge?.breakdown?.overLimit === 1 ||
    turn.nudge?.breakdown?.emergencyOverride === 1;
  const hasContent = turn.nudge?.shouldInject === true;
  const anySuccess = compressOutcomes.some((o) => o.success);

  if (anySuccess) ep.streak = 0;
  else if (overLimit && hasContent) ep.streak += 1;
  else ep.streak = 0;

  const hard = limit > 0 && usage >= settings.hardThreshold;
  const streakTripped = ep.streak >= settings.afterIgnores;
  if (!hard && !streakTripped) return null;
  if (!hasContent) return null;
  if (ep.lastAutoCompressedTurnKey === turnKey) return null;
  if (limit <= 0 || usage <= settings.targetPct) return null;

  const ranges = pickAutoRanges(turn.nudge, usage, limit, settings);
  if (ranges.length === 0) return null;

  const refMap = turn.state.messageRefs;
  const specs: CompressRangeSpec[] = ranges.map((r) => ({
    startRef: r.startRef,
    endRef: r.endRef,
    summary: buildHeuristicSummary(messagesInRange(coreMessages, refMap, r.startRef, r.endRef), r.startRef, r.endRef),
    topic: AUTO_TOPIC,
  }));

  const applied = runtime.core.applyCompression({ ranges: specs, messages: turn.messages, state: turn.state, config });
  const { blocksCreated, tokensCompressed, errors } = applied.result;
  if (blocksCreated === 0) {
    ep.lastAutoCompressedTurnKey = turnKey;
    logWarn("auto-compress", { sid, event: "no-blocks", ranges: ranges.length, errors: errors.slice(0, 3) });
    return null;
  }
  await runtime.save(applied.state, ctx);
  const newTurn = runtime.core.processTurn({ messages: coreMessages, state: applied.state, config, tokenCount });
  const reason: "hard" | "streak" = hard ? "hard" : "streak";
  const streakBefore = ep.streak;
  ep.lastAutoCompressedTurnKey = turnKey;
  ep.streak = 0;
  logInfo("auto-compress", { sid, event: "applied", reason, usageBefore: Math.round(usage * 100), blocksCreated, tokensCompressed, ranges: ranges.length, streakBefore });
  debug.event("auto-compress", { sid, reason, usageBefore: Math.round(usage * 100), blocksCreated, tokensCompressed, spans: ranges.map((r) => `${r.startRef}..${r.endRef}`) });
  if (ctx.hasUI) {
    const pct = Math.round(usage * 100);
    ctx.ui.notify(reason === "hard"
      ? `[ACP] context at ${pct}% (hard limit) — auto-compressed ${blocksCreated} block(s) (~${tokensCompressed} tokens) without waiting for the model.`
      : `[ACP] context at ${pct}% — model ignored ${settings.afterIgnores} compression nudges; auto-compressed ${blocksCreated} block(s) (~${tokensCompressed} tokens).`);
  }
  return { turn: newTurn, blocksCreated, tokensCompressed, usageBefore: usage, reason };
}
