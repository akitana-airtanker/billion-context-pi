/**
 * Search index — bridges pi's session log into acp-kernel's search.
 *
 * Builds SearchDoc[] from:
 *  1. All compression blocks (active AND inactive) — via blockDocs()
 *  2. All historical messages from the append-only session log — via getEntries()
 *
 * Each historical message is mapped to the block that compressed it (if any),
 * so a message hit tells the model exactly which block to decompress for the
 * surrounding detail. Messages still visible in context have no owning block.
 *
 * Token estimates use the same chars/4 + CJK heuristic as the kernel.
 */

import type { ExtensionContext, SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { blockDocs, messageDocs, type SearchDoc, type MessageInput, type MessageRole } from "acp-kernel";
import { entriesToCoreMessages } from "./messages.js";
import type { CompressionState } from "acp-kernel";

/** ref prefix → owning blockId, built from every block's effectiveMessageIds. */
function buildMessageOwnerMap(state: CompressionState): Map<string, string> {
    const m = new Map<string, string>();
    for (const b of state.blocks) {
        for (const id of b.effectiveMessageIds) {
            // first block (lowest tier, earliest) wins — outermost summary owns it
            if (!m.has(id)) m.set(id, b.blockId);
        }
    }
    return m;
}

/** Estimate tokens with CJK awareness (matches kernel defaultCountTokens). */
function estimateTokens(text: string): number {
    if (!text) return 0;
    const cjk = text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    const cjkCount = cjk?.length ?? 0;
    return cjkCount + Math.ceil((text.length - cjkCount) / 4);
}

/** Map pi message role → acp-kernel MessageRole. Tool calls count as assistant. */
function toRole(entry: SessionMessageEntry): MessageRole | null {
    const role = entry.message.role;
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    if (role === "toolResult") return "tool";
    return null;
}

/**
 * Build the full searchable document set for one session.
 * Called per searchBlocks invocation. Reads are cheap (in-memory entry tree).
 *
 * Visibility check: ACP does NOT write pi `compaction` entries (it prunes
 * messages itself in processTurn), so pi's buildContextEntries returns ALL
 * entries. The real visible set is the post-prune coreMessages from stateFor.
 */
export function buildSearchDocs(
    ctx: ExtensionContext,
    state: CompressionState,
    visibleCoreMessages: { id?: string }[],
): SearchDoc[] {
    const sm = ctx.sessionManager;
    const allEntries: SessionEntry[] = sm.getEntries();
    const ownerMap = buildMessageOwnerMap(state);

    // Visible = the post-prune messages ACP actually keeps in context.
    const liveIds = new Set<string>();
    for (const m of visibleCoreMessages) if (m.id) liveIds.add(m.id);

    const blockTier = new Map<string, number>();
    for (const b of state.blocks) blockTier.set(b.blockId, b.tier ?? 1);

    const msgs: MessageInput[] = [];
    for (const entry of allEntries) {
        if (entry.type !== "message") continue;
        const role = toRole(entry);
        if (!role) continue;

        const cores = entriesToCoreMessages([entry]);
        for (const cm of cores) {
            if (!cm.id) continue;
            // skip messages still visible in context — model can already see them
            if (liveIds.has(cm.id)) continue;
            const text = cm.text ?? "";
            if (!text || text.length < 2) continue;
            const ownerBlock = ownerMap.get(cm.id);
            msgs.push({
                ref: cm.id,
                role,
                text,
                tokens: estimateTokens(text),
                blockId: ownerBlock,
                tier: ownerBlock ? blockTier.get(ownerBlock) : undefined,
            });
        }
    }

    return [...blockDocs(state), ...messageDocs(msgs)];
}
