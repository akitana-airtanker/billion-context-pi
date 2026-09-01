# External ACP Compression Model — Implementation Plan

> Execute from `/Users/akira.tanaka/tmp/billion-context-pi`. Keep the working tree isolated to this fork. Follow `AGENTS.md`: strict TypeScript ESM, no `as any`/`@ts-ignore`, Node built-in tests, and keep `package-lock.json` synchronized.

## Objective

Add optional external-model routing for ACP compression. The active model still selects the range and topic through the existing `compress` tool; the configured model generates the summary from the original selected messages. Default fork configuration targets `openai-codex/gpt-5.6-luna` at `xhigh`, with fallback to the active model's existing summary path on any external failure.

## Design constraints

- Do not modify Pi core's built-in compaction behavior.
- Do not change ACP range selection, protected-range rules, tier rewrites, or state lineage.
- Do not add a separate credential store or unapproved HTTP client path.
- Never log conversation or summary content.
- Prevent the external request from recursively invoking ACP compression.
- Preserve upstream behavior when the new setting is absent or disabled.

## Implementation steps

### 1. Establish the host-model adapter boundary

- Inspect the installed Pi host package declarations and source to identify the supported model-resolution and request/streaming API available to an extension at runtime.
- Confirm how provider/model IDs and thinking levels are represented (`openai-codex/gpt-5.6-luna:xhigh`) and how authentication is reused.
- Record the chosen API and its relevant types in the implementation PR/commit; do not invent a second provider path.
- Define a narrow port, for example `CompressionModelInvoker`, whose input is a resolved model reference plus a tool-less prompt and whose output is text or a typed failure.

### 2. Add configuration parsing and resolution (tests first)

Files:

- `src/config.ts`
- `src/user-config.ts` if user-facing config normalization belongs there
- `tests/config.test.ts`

Add an optional compression-model configuration separate from kernel tuning:

```ts
export interface CompressionModelConfig {
  provider: string;
  model: string;
  thinkingLevel?: string;
}
```

Use the repository's existing config naming/normalization conventions. Required behavior:

- absent config means active-model compression, preserving current behavior;
- valid provider/model/thinking-level values resolve predictably through existing precedence;
- invalid or incomplete values are rejected or treated as disabled according to existing config conventions;
- credentials remain outside ACP config;
- the fork's default configuration can enable Luna without changing `maxContextLimit`, `emergencyThresholdPercent`, or `nudgeGrowthTokens`.

### 3. Extract pure message serialization and prompt construction (tests first)

Create a focused module, likely `src/compression-summarizer.ts` or equivalent, with pure functions for:

- serializing original `user`, `assistant`, and `tool` messages with explicit role boundaries;
- constructing a tool-less summary request from the selected range, topic, ACP fidelity rules, and lineage context;
- validating non-empty/valid model output;
- classifying external failures into stable, non-content-bearing categories.

Use property-based/generated inputs where practical to verify role preservation, arbitrary range ordering/coverage, delimiters, and no accidental loss of message text. Keep output limits bounded to avoid sending unbounded requests.

### 4. Implement the external summarizer adapter

Files likely:

- `src/compression-summarizer.ts`
- a small host adapter module if Pi API types require one
- `src/log.ts` for redacted telemetry, if needed

Implement `ExternalModelSummarizer` using the host API found in step 1:

- resolve `openai-codex/gpt-5.6-luna` and `xhigh`;
- issue a dedicated tool-less request;
- pass original serialized messages, not a prior summary;
- enforce timeout/cancellation behavior compatible with the extension lifecycle;
- return validated text only;
- record model identity, latency, failure class, and fallback usage only.

### 5. Integrate fallback at the compression seam (tests first)

Files:

- `src/compress-tool.ts`
- `src/runtime.ts` if dependency injection belongs in runtime
- `src/index.ts` for lifecycle/model wiring
- `tests/compress-tool.test.ts`

Refactor the existing `handleCompress` flow minimally:

1. retain current request/range validation and state computation;
2. resolve the selected original messages;
3. call the external summarizer when configured;
4. if it fails, use the existing active-model `summary` argument;
5. pass exactly one validated summary to `runtime.core.applyCompression`;
6. save atomically as today.

Ensure the existing tool contract remains compatible with active-model calls and that failures do not create partial blocks or alter state. If the current architecture cannot access a model invoker from `AcpRuntime`, inject the port from `createAcpExtension` rather than coupling the kernel to Pi APIs.

### 6. Add regression and adapter tests

Add deterministic fakes for the host model API and cover:

- successful Luna summary and persisted ACP block metadata;
- provider/model/thinking-level resolution;
- timeout, auth, missing-model, rate-limit, transport, empty-output, and invalid-output fallback;
- no partial block after external failure;
- no recursive compression invocation;
- no conversation content in logs;
- absent/disabled config preserves current behavior;
- existing dead-range, cap, CJK token, tier-3 rewrite, and lineage tests continue to pass.

Keep real Luna calls in an opt-in E2E test only; never require network/authentication for the default suite.

### 7. Update user-facing documentation and defaults

Files:

- `CONFIGURATION.md`
- `CONFIGURATION.zh-CN.md` if the repository maintains parallel documentation
- `README.md` only if configuration discovery requires it

Document the optional setting, the default fork behavior, active-model fallback, credential ownership, privacy/logging policy, and how to disable routing to recover upstream behavior. Do not claim Pi core asynchronous compaction; this change only routes ACP's model-driven compression request.

### 8. Verify, review, and publish

Run in order:

```sh
npm test
npm run typecheck
npm run build
npm run e2e   # only if local E2E prerequisites are present; otherwise report skipped
```

Then inspect `git diff --check`, `git status --short`, and the complete diff. Confirm no lockfile drift, secrets, message-content logs, or generated artifacts. Commit implementation and tests as a focused commit, push the fork, and report exact commit/verification evidence.

## Checkpoints

- **Checkpoint A:** host API and config seam identified; config/serialization tests pass.
- **Checkpoint B:** external adapter and fallback integration tests pass; existing tests remain green.
- **Checkpoint C:** typecheck/build/docs pass; diff reviewed for privacy and compatibility.
- **Checkpoint D:** optional real Luna E2E run, if credentials/network are available; otherwise explicitly mark it not run.

## Expected final behavior

With the fork's compression-model setting enabled, every ACP `compress` operation still originates from the active model's tool call, but its selected original range is summarized by `openai-codex/gpt-5.6-luna:xhigh`. If that request cannot produce a valid summary, the active model's supplied summary is used and the ACP state remains consistent. With the setting absent/disabled, behavior is unchanged from upstream.
