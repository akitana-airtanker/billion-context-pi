import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createInitialState, type CompressionState } from "acp-kernel";

const STATE_SUFFIX = ".acp.json";

function stateFileFor(sessionFile: string | undefined, sessionId: string): string | null {
  if (sessionFile) return sessionFile + STATE_SUFFIX;
  if (sessionId) return path.join(process.cwd(), `.acp-${sessionId}${STATE_SUFFIX}`);
  return null;
}

export class SessionStateStore {
  private cache: CompressionState | null = null;
  private loadedKey: string | null = null;

  async load(sessionFile: string | undefined, sessionId: string): Promise<CompressionState> {
    const file = stateFileFor(sessionFile, sessionId);
    if (file && this.loadedKey === file && this.cache) return this.cache;
    let state = createInitialState();
    if (file) {
      try {
        const raw = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(raw) as CompressionState;
        if (parsed && Array.isArray(parsed.blocks)) state = mergeInitialState(parsed);
      } catch {
        // missing/corrupt file -> fresh state
      }
    }
    this.cache = state;
    this.loadedKey = file;
    return state;
  }

  async save(state: CompressionState, sessionFile: string | undefined, sessionId: string): Promise<void> {
    const file = stateFileFor(sessionFile, sessionId);
    if (!file) return;
    this.cache = state;
    this.loadedKey = file;
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const tmp = path.join(dir, `.acp-tmp-${path.basename(file)}`);
    await fs.writeFile(tmp, JSON.stringify(state), "utf8");
    await fs.rename(tmp, file);
  }

  invalidate(): void {
    this.cache = null;
    this.loadedKey = null;
  }
}

// Persisted state may predate new fields; fill any gaps so acp-kernel always sees
// a complete CompressionState (forward-compatible load).
function mergeInitialState(parsed: CompressionState): CompressionState {
  const fresh = createInitialState();
  return {
    blocks: parsed.blocks ?? fresh.blocks,
    messageRefs: parsed.messageRefs ?? fresh.messageRefs,
    nudge: { ...fresh.nudge, ...(parsed.nudge ?? {}) },
    stats: { ...fresh.stats, ...(parsed.stats ?? {}) },
    nextBlockId: parsed.nextBlockId ?? fresh.nextBlockId,
    nextRunId: parsed.nextRunId ?? fresh.nextRunId,
  };
}
