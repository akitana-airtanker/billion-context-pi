import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  createCore,
  defaultCountTokens,
  type CompressionCore,
  type CompressionState,
  type Config,
} from "acp-kernel";
import { resolveConfig, type AdapterConfig } from "./config.js";
import { entriesToCoreMessages } from "./messages.js";
import { SessionStateStore } from "./state.js";

export interface AcpRuntime {
  core: CompressionCore;
  store: SessionStateStore;
  adapter: AdapterConfig;
  setAdapter(adapter: AdapterConfig): void;
  liveContextLimit(ctx: ExtensionContext): number;
  configFor(ctx: ExtensionContext): Config;
  stateFor(ctx: ExtensionContext): Promise<{ state: CompressionState; coreMessages: ReturnType<typeof entriesToCoreMessages>; entries: SessionEntry[] }>;
  save(state: CompressionState, ctx: ExtensionContext): Promise<void>;
  acquireLock(sid: string): Promise<() => void>;
}

export function createRuntime(adapter: AdapterConfig): AcpRuntime {
  const core = createCore({ countTokens: defaultCountTokens });
  const store = new SessionStateStore();
  const locks = new Map<string, Promise<void>>();
  let adapterRef = adapter;

  async function acquireLock(sid: string): Promise<() => void> {
    const prev = locks.get(sid) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = () => {
        locks.delete(sid);
        resolve();
      };
    });
    locks.set(sid, prev.then(() => next));
    await prev;
    return release;
  }

  function liveContextLimit(ctx: ExtensionContext): number {
    const m = ctx.model as { contextWindow?: number } | undefined;
    return m?.contextWindow ?? 0;
  }

  function configFor(ctx: ExtensionContext): Config {
    return resolveConfig(adapterRef, liveContextLimit(ctx));
  }

  async function stateFor(ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    const state = await store.load(sm.getSessionFile() ?? undefined, sm.getSessionId());
    const entries = sm.buildContextEntries();
    return { state, coreMessages: entriesToCoreMessages(entries), entries };
  }

  async function save(state: CompressionState, ctx: ExtensionContext) {
    const sm = ctx.sessionManager;
    await store.save(state, sm.getSessionFile() ?? undefined, sm.getSessionId());
  }

  return { core, store, adapter: adapterRef, setAdapter: (a) => { adapterRef = a; }, liveContextLimit, configFor, stateFor, save, acquireLock };
}
