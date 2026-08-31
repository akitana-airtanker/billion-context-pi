// Stale-anchor detection for the issue #257 provider-usage floor.
//
// pi's getContextUsage() anchors on the LAST assistant message carrying valid
// provider usage (compaction.js getAssistantUsage: skips aborted / error /
// all-zero-usage). A successful ACP compress lands AFTER that anchor, so on
// the very next LLM call the anchor still reflects the pre-compress (larger)
// request. Flooring the meter with it would re-run the pre-compress
// emergency decision (nudge injection + mechanical tool-result truncation)
// on a context that was just shrunk, and the panel would keep showing the
// old large number right after a successful compress. The anchor only
// refreshes when the next assistant response arrives with fresh usage.
//
// pi has the same concern for its own compaction (agent-session: "Verify the
// usage source is post-compaction. Kept pre-compaction messages have stale
// usage reflecting the old (larger) context and would falsely trigger
// compaction right after one just finished."). This module mirrors that
// check for ACP compression: while the anchor predates the last successful
// compress toolResult, the floor is skipped (sent view alone arbitrates).
import { isCompressSuccessText } from "./compress-tool.js";
import { extractText } from "./messages.js";

type UsageLike = {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | null | undefined;

type AnchorEntry = {
  type: string;
  message?: {
    role?: string;
    stopReason?: string;
    usage?: UsageLike;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    content?: unknown;
  };
};

// Same validity rule as pi's getAssistantUsage + calculateContextTokens:
// totalTokens, or the sum of the component counters, must be > 0.
function validAnchorUsage(u: UsageLike): boolean {
  if (!u) return false;
  const total = (u.totalTokens ?? 0) || (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  return total > 0;
}

/** True when the last valid assistant usage anchor comes strictly BEFORE the
 *  last successful compress toolResult — i.e. the host's provider-usage
 *  number still reflects the pre-compression request and must not floor the
 *  meter for the next LLM call. Failed / no-op compresses do not count
 *  (nothing was reclaimed, the anchor is still accurate). */
export function usageAnchorPredatesCompression(entries: AnchorEntry[]): boolean {
  let lastUsageIdx = -1;
  let lastCompressIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    const m = entries[i]!.message;
    if (!m) continue;
    if (m.role === "assistant" && m.stopReason !== "aborted" && m.stopReason !== "error" && validAnchorUsage(m.usage)) {
      lastUsageIdx = i;
    } else if (
      m.role === "toolResult" &&
      m.toolName === "compress" &&
      m.toolCallId !== undefined &&
      m.isError !== true &&
      isCompressSuccessText(extractText(m.content))
    ) {
      lastCompressIdx = i;
    }
  }
  return lastCompressIdx > lastUsageIdx;
}
