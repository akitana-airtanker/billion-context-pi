# pai-acp

**Active Context Pruning for [Pi](https://pi.dev)** — model-driven context compression that keeps long conversations flowing without losing important details.

[![npm version](https://img.shields.io/npm/v/pai-acp.svg)](https://www.npmjs.com/package/pai-acp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why?

When conversations get long, the model runs out of context. Most tools hard-truncate — silently dropping earlier messages. **ACP** gives the model a `compress` tool: the LLM decides **when** and **what** to compress into high-fidelity summaries, preserving critical details (file paths, decisions, error strings) while reclaiming context space.

Unlike Pi's built-in auto-compaction (which replaces everything with a single summary), ACP:
- **Preserves structure** — compressed ranges become labeled blocks you can decompress later
- **Multi-tier** — summaries can be further distilled (T1 → T2 → T3) as sessions grow
- **Searchable** — `search_context` finds information inside compressed blocks without decompressing
- **Selective** — protected tools, user messages, and file patterns are never compressed

## Install

```bash
pi install npm:pai-acp
```

That's it. The extension auto-loads on next Pi startup. No configuration needed — it reads your model's context window automatically.

## How it works

ACP intercepts Pi's `context` event (fired before each LLM call) and runs a 9-stage pipeline:

```
assign refs → sync blocks → merge → prune → filter → hide calls → nudge → truncate → render
```

Each message gets an invisible `<acp>` ref tag (`m00001`, `m00002`, ...) visible to the model but not the user. The model uses these refs to specify compression ranges.

Pi's built-in auto-compaction is cancelled — ACP is the sole context manager.

## Features

### 4 model-facing tools

| Tool | What it does |
|------|-------------|
| `compress` | Replace a contiguous message range with a detailed summary |
| `decompress` | Restore a previously compressed block's content |
| `search_context` | Search compressed block summaries by keyword (find info without decompressing) |
| `acp_status` | Show context usage, compressed blocks, compressible ranges |

### `/acp` command

Rich status display for the user:

```
╭─────────────────────────────────────────────╮
│           ACP Context Analysis              │
╰─────────────────────────────────────────────╯
 pai-acp@0.1.3

Context: 12% (120K / 1.0M)
Growth: +15K since last nudge

Token Breakdown:
  System     ░░░░░░░░░░░░░░░░░░░░   2%  2.1K
  Tool       ████████████░░░░░░░░  58%  69.6K
  Summaries  ████░░░░░░░░░░░░░░░░  20%  24.0K
  Code       ██░░░░░░░░░░░░░░░░░░  10%  12.0K
  Text       █░░░░░░░░░░░░░░░░░░░   5%  6.0K

Blocks: 3 active (3.7K summary, 15.2K original compressed)
  b1 (T1)  3.7K→599  age=5m  "API exploration"
  b2 (T1)  8.2K→2.1K  age=2m  "Debug session"
  b3 (T2)  3.3K→1.0K  age=1m  "Architecture review"
```

### Auto-update

On each Pi startup, pai-acp checks npm for a newer version and auto-installs it. No manual updates needed — just restart Pi. To disable (no network calls on startup), set `autoUpdate: false` in the config or env `ACP_AUTO_UPDATE=0`.

### Compression philosophy in system prompt

The model receives detailed guidance on **when** to compress, **what** to keep verbatim (paths, signatures, errors, decisions), and **what** to drop (verbose logs, duplicates, consumed exploration).

## Configuration

Defaults work out of the box. For advanced customization:

```ts
import { createAcpExtension } from "pai-acp";

export default createAcpExtension({
  modelContextLimit: 200_000,
  protectedTools: ["skill", "task"],
  preserveRecentMessages: 20,
  nudge: {
    minContextLimitPct: 0.45,    // start nudging at 45% usage
    emergencyThresholdPct: 0.80,  // force compress at 80%
  },
});
```

## Built on acp-kernel

The compression engine is [`acp-kernel`](https://github.com/ranxianglei/acp-kernel) — a platform-agnostic, MIT-licensed library with 184 tests. It's bundled inline into `dist/index.js`, so there are zero runtime dependencies.

## License

MIT.
