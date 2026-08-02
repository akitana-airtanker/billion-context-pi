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
- **Selective** — protected tools, user messages, and the recent working set are never compressed

## Install

```bash
pi install npm:pai-acp
```

That's it. The extension auto-loads on next Pi startup. No configuration needed — it reads your model's context window automatically.

> **Uninstall `pi-subagents` first (optional, recommended).** pai-acp ships its own `acp_delegate` sub-agent tool (see below) that replaces pi-subagents at a fraction of the context cost (~600 tok vs ~7K tok/turn). If you have pi-subagents installed, remove it to avoid duplicate delegation tools:
> ```bash
> pi remove npm:pi-subagents
> ```

## How it works

ACP intercepts Pi's `context` event (fired before each LLM call) and runs an 8-stage pipeline:

```
assign refs → sync blocks → prune → filter → hide calls → recommend → nudge → emergency truncate
```

Each message gets an invisible `<acp>` ref tag (`m00001`, `m00002`, ...) visible to the model but not the user. The model uses these refs to specify compression ranges.

Pi's built-in auto-compaction is cancelled — ACP is the sole context manager.

## Model-facing tools

| Tool | What it does |
|------|-------------|
| `compress` | Replace a contiguous message range with a detailed summary |
| `decompress` | Restore a previously compressed block's content |
| `search_context` | Search compressed block summaries (and visible messages) by keyword |
| `acp_status` | Show context usage, compressed blocks, compressible ranges |
| `acp_delegate` | Spawn a clean-context sub-agent for a task (review / research / implement / plan / advise) |
| `acp_delegate_status` | List active and recent delegate runs |
| `acp_delegate_cancel` | Cancel a running delegate by runId |

### acp_delegate — clean-context delegation

Hand a self-contained task to a fresh pi process running in a clean context. Five built-in roles, each with a tailored tool whitelist and system prompt:

| Role | Tools | Best for |
|------|-------|----------|
| `reviewer` | read, bash | Read-only code review (bugs, risks, file:line) |
| `researcher` | read, bash | Read-only codebase investigation |
| `worker` | read, edit, write, bash | Make code changes |
| `planner` | read, bash | Analyze + propose a step-by-step plan |
| `oracle` | read, bash | Answer questions / advise |

The full delegate result is saved to a file (`/tmp/acp-delegate/<runId>.out`); the tool result and injected notification carry only the **task title + file path** (no preview) — use `read` for the details. This keeps the parent context lean.

- **Interactive (TUI) & RPC modes**: `async:true` (default) runs the child in the background; a short completion notification is injected into the chat when it finishes.
- **Print / JSON modes** (`pi -p`, SDK): `async:true` auto-downgrades to **synchronous** — the result returns as the tool result in the same turn (the parent exits after one turn, so background injection would be lost).

## `/acp` command

Rich status display for the user:

```
╭─────────────────────────────────────────────╮
│           ACP Context Analysis              │
╰─────────────────────────────────────────────╯
 pai-acp@0.1.14

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

## Configuration

pai-acp works out of the box with no configuration. Three optional keys can be set in a JSON config file.

### Config file

Create `~/.pi/acp.json` (global) and/or `<project>/.pi/acp.json` (project-local, overrides global):

```json
{
  "debug": false,
  "autoUpdate": true,
  "modelContextLimit": 200000
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `debug` | `false` | Write diagnostic events to `~/.pi/acp-debug.log`. Also enabled by env `ACP_DEBUG=1`. |
| `autoUpdate` | `true` | On Pi startup, check npm for a newer version and auto-install it (throttled to one check per 3 minutes). Disable to avoid all startup network calls. |
| `modelContextLimit` | *(auto)* | Override the context limit (in tokens). Defaults to the model's `contextWindow`. |

> **Only these three keys are read from `acp.json`.** Other tuning knobs (`preserveRecentMessages`, `protectedTools`, nudge thresholds) are code-level and not user-overridable.

### Environment variables

| Variable | Effect |
|----------|--------|
| `ACP_AUTO_UPDATE` | Set to `0` / `false` / `no` / `off` (case-insensitive) to disable auto-update, overriding the config. |
| `ACP_MODEL_CONTEXT_LIMIT` | Override the context limit. Takes precedence over the config value. |
| `ACP_DEBUG` | Set to `1` or `true` to enable debug logging. |

### Compression philosophy

The model receives detailed guidance (in its system prompt) on **when** to compress, **what** to keep verbatim (paths, signatures, errors, decisions, user intent), and **what** to drop (verbose logs, duplicates, consumed exploration). This guidance is injected on every turn so it stays in the model's attention.

### What gets protected

ACP protects three categories of content from compression:

1. **Always-protected tools** — `compress` calls are hard-protected (they're load-bearing metadata; compressing them breaks decompress and the "summary is historical" contract).
2. **Soft recent-zone** — the last N messages (default 5) and last ~5K tokens are soft-protected so the model keeps its working set. Tool results from `decompress`, `search_context`, `read`, and `bash` are **excluded** from this zone: they're large and meant to be compressible once consumed, so they don't eat the protected budget.
3. **Last user message** — always protected (user intent must survive).

## Built on acp-kernel

The compression engine is [`acp-kernel`](https://github.com/ranxianglei/acp-kernel) — a platform-agnostic, MIT-licensed library with 208 tests. It's bundled inline into `dist/index.js`, so there are zero runtime dependencies.

## License

MIT.
