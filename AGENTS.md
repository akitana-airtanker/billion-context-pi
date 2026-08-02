# pai-acp Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**pai-acp** is the [Pi coding agent](https://github.com/nickthecook/pi) adapter for ACP (Active Context Pruning). It wires acp-kernel's compression pipeline into Pi's extension system, providing model-driven context management.

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
│   ├── system-prompt.ts      # System prompt with compression philosophy
│   ├── update.ts             # Auto-update: checks npm, auto-installs latest
│   ├── tokens.ts             # Token estimation utilities
│   └── log.ts                # Debug logging
├── tests/                    # 45 tests
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

Same as acp-kernel. Release branches: `YYYY-MM-DD_release-v{VERSION}`.

## 6. npm Publishing

```bash
npm run build
npm test
npm publish
```

CI auto-publishes on release branch merge. Manual publish only as fallback.
