# pai-acp Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**pai-acp** is the [Pi coding agent](https://github.com/nickthecook/pi) adapter for ACP (Active Context Pruning). It wires acp-kernel's compression pipeline into Pi's extension system, providing model-driven context management.

Beyond compression, pai-acp ships a lightweight **sub-agent delegation** subsystem: the `acp_delegate` / `acp_delegate_wait` / `acp_delegate_cancel` tools spawn fresh `pi` child processes (clean context) for focused review/research/implementation tasks, with async results injected back into the parent chat. A live TUI status widget (`fleet-widget.ts`) shows running delegates. `setup-subagent-tools.ts` patches `~/.pi/agent/settings.json` so builtin subagents inherit ACP tools. The subsystem is ~900 lines across three files and is considered feature-complete — no further growth is planned.

### Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling, inlines acp-kernel) |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Runtime Dep | `acp-kernel` (bundled at build time, zero runtime deps in dist) |
| Host | Pi `@earendil-works/pi-coding-agent` >=0.83 |

### Repository Info

| Field | Value |
|-------|-------|
| npm package | `pai-acp` |
| GitHub | https://github.com/ranxianglei/pai-acp |
| License | MIT |

## 2. Architecture

### Module Map

```
pi-acp/
├── src/
│   ├── index.ts              # Extension entry: wire hooks, tools, commands
│   ├── config.ts             # AdapterConfig: wraps kernel defaultConfig
│   ├── runtime.ts            # AcpRuntime: state store, lock, stateFor()
│   ├── state.ts              # State persistence (~/.pi/agent/sessions/*.acp.json)
│   ├── messages.ts           # Pi ↔ kernel message conversion + ref tag patching
│   ├── compress-tool.ts      # compress tool handler
│   ├── decompress-tool.ts    # decompress tool handler
│   ├── search-tool.ts        # search_context tool (delegates to kernel.searchBlocks)
│   ├── search-index.ts       # Builds SearchDoc[] from session log + ACP blocks
│   ├── status-tool.ts        # acp_status tool (delegates to kernel.buildStatusReport)
│   ├── commands.ts           # /acp slash command
│   ├── delegate-tool.ts      # Sub-agent delegation: spawn child Pi, wait/cancel tools
│   ├── fleet-widget.ts       # TUI status widget showing live delegate runs
│   ├── setup-subagent-tools.ts  # Patches ~/.pi/agent/settings.json: inject ACP tools into builtin subagents
│   ├── system-prompt.ts      # System prompt with compression philosophy
│   ├── update.ts             # Auto-update: checks npm, auto-installs latest
│   ├── user-config.ts        # User config (~/.pi/acp.json + project-level overrides)
│   ├── tokens.ts             # Token estimation utilities
│   └── log.ts                # Debug logging
├── tests/                    # 47 tests
├── tsup.config.ts
└── package.json
```

### Key Design Decisions

1. **acp-kernel is bundled inline** — tsup does NOT list it in `external`, so `dist/index.js` is self-contained (zero runtime deps)
2. **Tags use XML format** `<acp tokens="2" type="text">m00001</acp>` — written with hex escapes (`\x3c`, `\x3e`) to avoid Write/Edit tool stripping
3. **Assistant messages skip tag injection** — prevents model echo of XML tags
4. **Tags appended to END of text** — matches opencode-acp pattern
5. **Auto-update on session_start** — checks npm registry (6h throttle), auto-installs if newer
6. **acp-kernel MUST be pinned to an exact version** (e.g. `"acp-kernel": "0.0.14"`, NEVER `"^0.0.14"`). Because acp-kernel is a build-time dependency that tsup bundles inline into `dist`, a caret range makes the resolved version drift if `package-lock.json` is regenerated or absent, breaking reproducible builds. When bumping acp-kernel: set the exact version in `package.json`, run `npm install` to refresh the lockfile, then rebuild. The `package-lock.json` is committed and kept in sync.

### Delegate Subsystem

A self-contained (~900 lines, 3 files) feature for spawning focused sub-tasks as fresh `pi` child processes. Design points:

1. **Child process isolation** — `delegate-tool.ts:spawn` launches a separate `pi` invocation in a tmpdir; the child runs with a clean context (no parent history), so delegation is NOT a compression mechanism — it is a parallel-execution mechanism.
2. **Three tools** — `acp_delegate` (spawn + return runId), `acp_delegate_wait` (block until done, returns child output), `acp_delegate_cancel` (signal child). All in `delegate-tool.ts`.
3. **Toggle via config** — `AdapterConfig.delegate` (default `true`); when `false`, the tools are not registered and the widget is skipped.
4. **Fleet widget** — `fleet-widget.ts` renders a TUI status row of live delegate runs, polled every 500ms via the host's widget API. Only active in TUI mode.
5. **Subagent tool injection** — `setup-subagent-tools.ts` patches `~/.pi/agent/settings.json` on session start to add ACP tools (`compress`, `search_context`, etc.) to Pi's builtin subagents' allow-lists, so delegated children also benefit from compression. Creates a timestamped backup before writing; no-op if already patched.
6. **Feature-complete** — no new subsystem work is planned. Bug fixes and Pi API drift only.

## 3. Development Standards

### Build Commands

```bash
npm run build          # tsup bundle (inlines acp-kernel)
npm run typecheck      # TypeScript type checking
npm test               # node --import tsx --test tests/*.test.ts
```

### Local Testing

```bash
npm run build
cp dist/index.js ~/.pi/agent/npm/node_modules/pai-acp/dist/index.js
# Restart Pi to pick up changes
```

### Code Quality

- **No `as any`**, **No `@ts-ignore`**
- **No comments unless absolutely necessary**
- Hex escapes required for any `<acp>` XML in source files

## 4. Git Safety Rules

Same as acp-kernel. See [acp-kernel AGENTS.md §4](https://github.com/ranxianglei/acp-kernel/blob/master/AGENTS.md).

### PR Merge — Absolute Prohibition

PR merges are **human-only**. The Agent MUST NEVER merge any PR.

## 5. Release Workflow

Same baseline as acp-kernel (branch naming, CI auto-publish, PR-merge-is-human-only, pre-flight checks, release-commit convention). See [acp-kernel AGENTS.md §5](https://github.com/ranxianglei/acp-kernel/blob/master/AGENTS.md). Release branches: `YYYY-MM-DD_release-v{VERSION}`.

### Cross-repo dependency: acp-kernel MUST ship first

`acp-kernel` is pinned in **devDependencies** (exact version, no `^`) and **bundled inline** at build time (tsup does NOT mark it `external`), so `dist/index.js` is self-contained.

⚠️ **Publishing order is strict:**
1. Release `acp-kernel` first (open + merge its release PR, wait for CI publish).
2. **Verify it is live on npm:** `npm view acp-kernel version` returns the new version.
3. THEN release pai-acp.

Rationale: pai-acp CI runs `npm ci`, which installs the exact `acp-kernel` version pinned in `package.json`. A release branch that bumps `acp-kernel` to a not-yet-published version fails CI at install time.

### Local pre-validation (saves a round-trip)

Before waiting for npm, validate the upgrade path locally using acp-kernel's own master build (skip if acp-kernel is already published):

```bash
# 1. In acp-kernel (on master):
npm run build

# 2. In pai-acp: overlay the new dist onto node_modules (local only, do NOT commit)
cp ~/projects/acp-kernel/dist/index.js     node_modules/acp-kernel/dist/index.js
cp ~/projects/acp-kernel/dist/index.js.map node_modules/acp-kernel/dist/index.js.map

# 3. Bump package.json (both lines, see below), then run pai-acp CI checks
npm run typecheck && npm test && npm run build
```

### pai-acp release commit — TWO version fields

Unlike acp-kernel (one line), a pai-acp release commit bumps BOTH its own version AND the `acp-kernel` dependency:

```diff
   "name": "pai-acp",
-  "version": "0.1.12",
+  "version": "0.1.13",
   ...
-  "acp-kernel": "0.0.14",
+  "acp-kernel": "0.0.15",
```

After editing, refresh the lockfile and commit it together:
```bash
npm install                              # updates package-lock.json
npm run typecheck && npm test && npm run build
```
Commit message: `release v{VERSION}` (same convention as acp-kernel). The commit touches `package.json` + `package-lock.json` (2 files).

## 6. npm Publishing

```bash
npm run build
npm test
npm publish
```

CI auto-publishes on release branch merge. Manual publish only as fallback.
