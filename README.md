# pai-acp

[ACP](https://github.com/ranxianglei/opencode-acp) (Active Context Pruning) for the [Pi](https://pi.dev) coding agent. Gives Pi model-driven context management: a `compress` tool that lets the LLM decide when and what to compress into summaries, instead of hard-truncating.

Built on [`acp-kernel`](https://github.com/ranxianglei/acp-kernel#readme) — the platform-agnostic, MIT-licensed context-compression engine.

## How it works

Pi fires a `context` event before every LLM call. This extension runs acp-kernel's pipeline on the active session branch and returns the transformed messages:

1. **assign refs** — tag every message `[mNNNNN]` (single source of truth)
2. **sync blocks** — deactivate orphaned compression blocks
3. **merge** — fuse accumulated old-gen blocks into a single summary
4. **prune** — replace compressed ranges with summary blocks
5. **filter** — pluggable message filters (e.g. drop verbose consumed tool output)
6. **hide compress calls** — fold historical `compress` tool calls out of view
7. **nudge** — when context grows past threshold, prompt the model to compress
8. **emergency truncate** — last safety valve if context still nears the limit
9. **render refs** — refresh `[mNNNNN]` tags from state

Pi's own auto-compaction is cancelled (`session_before_compact → { cancel: true }`) so ACP is the sole context manager.

## Install

```bash
pi install npm:pai-acp
```

Or clone into `~/.pi/agent/extensions/` / `.pi/extensions/` and run `npm i && npm run build`.

## Configuration

Defaults work out of the box. The extension reads `ctx.model.contextWindow` live each turn. To override, create the extension with options (in code):

```ts
import { createAcpExtension } from "pai-acp";

export default createAcpExtension({
  modelContextLimit: 200_000,
  protectedTools: ["skill", "task"],
  preserveRecentMessages: 20,
});
```

## Commands

Pi commands are flat (no subcommands), so ACP exposes:

| Command | Action |
|---------|--------|
| `/acp` `/acp-status` | Show context usage and compression stats |
| `/acp-decompress b3` | Restore a compressed block's summary |
| `/acp-search auth token` | Search compressed block summaries |

## The compress tool

The model calls it to reclaim context:

```
compress({
  content: [
    { startId: "m00005", endId: "m00020", summary: "...", topic: "API exploration" }
  ]
})
```

`startId` / `endId` are the `[mNNNNN]` refs of a contiguous range. The summary replaces the range — it should be self-contained (preserve paths, signatures, errors, decisions).

## Status

Experimental v1. Validated against Pi's type surface (typecheck + build clean), unit-tested for message conversion + state persistence, and **load-validated against real Pi v0.83.0** (`pi install` discovers the package; Pi initializes the extension and reaches the model-auth phase with no load/parse errors). The `typebox` schema library is bundled into `dist/index.js` — no runtime `typebox` dependency.

Full message-transform E2E (the `context` event actually transforming messages in a live turn + the `compress` tool being invoked by the model) still pending a model API key.

Known v1 limitations:
- Whether the registered `compress` tool lands in the model's active tool set by default — pending live-model E2E (`setActiveTools` would replace the whole set, so it is not called).
- Assistant messages with both text and tool calls project only the text (full block fidelity is a v2 goal).

## License

MIT.
