import { defaultCountTokens, type CoreMessage } from "acp-kernel";
import type { SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { countImageBlocks, extractText } from "./messages.js";
import { THROTTLE_KICK_SENTINEL } from "./throttle-retry.js";
import { DELEGATE_NOTIFY_PREFIX } from "./delegate-tool.js";

type AgentMessage = SessionMessageEntry["message"];

export function collectCoveredMessageIds(state: { blocks: { active: boolean; effectiveMessageIds: string[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.effectiveMessageIds) ids.add(id);
  }
  return ids;
}

// ~Anthropic screenshot cost; real per-model cost (85..2.8K) converges via density calibration.
export const IMAGE_TOKEN_COST = 1600;

// pi-ai silently drops image blocks for non-vision models, so they cost nothing there.
export function modelSupportsImages(model: unknown): boolean {
  const input = (model as { input?: string[] } | null | undefined)?.input;
  return Array.isArray(input) && input.includes("image");
}

// Keyed by entry id — the core id of user/toolResult messages (assistant tool-call cores split as `${id}#callId` and never carry images).
export function collectImageTokens(entries: { id: string; type?: string; message?: AgentMessage }[], visionCapable: boolean): Map<string, number> {
  const out = new Map<string, number>();
  if (!visionCapable) return out;
  for (const e of entries) {
    if (e.type !== "message") continue;
    const n = countImageBlocks((e.message as { content?: unknown } | undefined)?.content);
    if (n > 0) out.set(e.id, n * IMAGE_TOKEN_COST);
  }
  return out;
}

export function estimateTokens(messages: CoreMessage[], coveredIds?: Set<string>, imageTokensById?: Map<string, number>): number {
  let tokens = 0;
  for (const m of messages) {
    if (m.toolName === "compress") continue;
    if (coveredIds?.has(m.id)) continue;
    tokens += defaultCountTokens(m.text ?? "");
    const img = imageTokensById?.get(m.id);
    if (img) tokens += img;
  }
  return tokens;
}

/** Scale a raw (uncalibrated) sent-view estimate by the per-model density
 *  learned from provider usage (density = real/estimate). Used for nudge /
 *  usage / emergency arbitration at every processTurn site so the decision
 *  runs on the provider-anchored scale; the estimator itself is always fed
 *  the RAW estimate — see density.ts. */
export function calibrateTokens(estimate: number, density: number): number {
  return density === 1 ? estimate : Math.round(estimate * density);
}

// Synthetic user-message prefixes the injection-ledger turn key must skip.
// These are machinery injected via pi.sendUserMessage (throttle kicks,
// delegate notifications incl. appended recovery notices), not conversation.
// CAUTION: any NEW synthetic sendUserMessage injection site MUST add its
// prefix here too — otherwise it silently resets the per-turn injection
// budgets (see wireContextTransform in src/index.ts).
export const SYNTHETIC_USER_PREFIXES = [THROTTLE_KICK_SENTINEL, DELEGATE_NOTIFY_PREFIX] as const;

/** Id of the last GENUINE user-role entry — used as the per-turn key for
 *  injection budgets. Synthetic user messages (throttle kicks, delegate
 *  notifications) are skipped: they are machinery, not conversation, and
 *  letting them rotate the turn key would reset the very budgets that bound
 *  runaway injection loops. Returns undefined if there is no user message. */
export function lastUserMessageId(entries: { id: string; message?: { role?: string; content?: unknown } }[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.message?.role !== "user") continue;
    const text = extractText(e.message.content).trimStart();
    if (SYNTHETIC_USER_PREFIXES.some((p) => text.startsWith(p))) continue;
    return e.id;
  }
  return undefined;
}
