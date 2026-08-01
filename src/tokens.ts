import { defaultCountTokens, type CoreMessage } from "acp-kernel";

export function collectCoveredMessageIds(state: { blocks: { active: boolean; effectiveMessageIds: string[] }[] }): Set<string> {
  const ids = new Set<string>();
  for (const b of state.blocks) {
    if (!b.active) continue;
    for (const id of b.effectiveMessageIds) ids.add(id);
  }
  return ids;
}

export function estimateTokens(messages: CoreMessage[], coveredIds?: Set<string>): number {
  let tokens = 0;
  for (const m of messages) {
    if (m.toolName === "compress") continue;
    if (coveredIds?.has(m.id)) continue;
    tokens += defaultCountTokens(m.text ?? "");
  }
  return tokens;
}
