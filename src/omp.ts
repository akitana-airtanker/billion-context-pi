import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isPiHost } from "./runtime.js";

/**
 * Positive OMP (oh-my-pi) host detection.
 *
 * pi exposes `sessionManager.buildContextEntries()`; omp only exposes
 * `getBranch()`. `isPiHost` feature-detects the former, so its negation is the
 * established "omp path" used throughout the adapter (see runtime.stateFor).
 * We reuse that semantic so the refusal and the (now dormant) best-effort omp
 * path can never disagree about which host we are on.
 */
export function isOmpHost(sm: ExtensionContext["sessionManager"]): boolean {
  return !isPiHost(sm);
}

/**
 * Shown (and logged) when the extension detects an OMP host and stands down.
 * OMP's in-process live-entries integration is unreliable: the nudge's example
 * refs diverge from the session's real refs, so compress calls fail with
 * "does not exist in this session". The billion-context proxy runs compression
 * server-side (it owns the ref coordinate space) and works on OMP.
 */
export const OMP_UNSUPPORTED_MESSAGE = [
  "[billion-context-pi] This host is OMP (oh-my-pi), which is NOT supported — ACP has been disabled for this session.",
  "The in-process compression path is unreliable on OMP: the nudge's example refs diverge from the session's real refs, so compress calls fail with \"does not exist in this session\".",
  "Use the billion-context proxy instead — it runs compression server-side and works on OMP:",
  "  npm install -g billion-context",
  "  bili omp",
  "Docs: https://github.com/ranxianglei/billion-context",
].join("\n");
