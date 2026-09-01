# External Model Routing for ACP Compression

- **Status:** Approved design
- **Repository:** `akitana-airtanker/billion-context-pi` forked from `ranxianglei/billion-context-pi`
- **Date:** 2026-09-02

## Goal

Allow every ACP compression operation to generate its summary with a configurable external model. The initial default is `openai-codex/gpt-5.6-luna` at `xhigh` effort. The active conversation model continues to choose when and which range to compress.

## Scope

### In scope

- Add a configurable compression-model setting.
- Route all ACP `compress` operations through the configured summarizer.
- Use the Pi provider/model registry and existing provider authentication.
- Fall back to the active model's existing summary when the external request fails.
- Add unit, property, adapter, regression, and opt-in E2E coverage.

### Out of scope

- Changes to Pi core's built-in compaction.
- Changes to the ACP range-selection policy or protection rules.
- Storing provider credentials in ACP configuration.
- Making the active model's context history available to a separate ACP delegate process.

## Architecture

```text
Active model
  └─ compress(startId, endId, topic)
             ↓
      Resolve original range
             ↓
   CompressionSummarizer
      ├─ ExternalModelSummarizer (configured Luna)
      └─ ActiveModelSummarizer (fallback)
             ↓
        Atomic ACP block save
```

The active model remains responsible for selecting `startId`, `endId`, and `topic`. The external model receives the original messages in the selected range and generates only the summary. It cannot invoke tools or mutate ACP state.

The implementation should introduce a narrow summarizer seam around the existing compression handler. Message resolution, serialization, prompt construction, response validation, and block persistence should remain independently testable. Provider-specific invocation belongs in an adapter that uses Pi's existing model resolution/authentication APIs.

## Configuration

Proposed shape:

```json
{
  "compressionModel": {
    "provider": "openai-codex",
    "model": "gpt-5.6-luna",
    "thinkingLevel": "xhigh"
  }
}
```

The setting is optional. When absent, current active-model compression behavior is preserved. Configuration must contain routing data only; credentials remain in Pi's existing provider configuration.

## Data flow

1. Validate the existing `compress` request and resolve its ACP range.
2. Read the original range from the ACP/session index.
3. Serialize `user`, `assistant`, and `tool` entries with role boundaries.
4. Build a dedicated, tool-less summarization request containing the existing ACP fidelity rules, selected topic, and range lineage.
5. Resolve and call the configured model (`openai-codex/gpt-5.6-luna:xhigh`).
6. Reject empty or invalid output.
7. Persist the validated summary as the ACP block, retaining the existing range, topic, and tier metadata.

The external model receives original messages, not an already-compressed active-model summary.

## Failure handling

- Treat authentication errors, missing models, timeouts, rate limits, transport errors, empty output, and invalid output as external summarizer failures.
- Do not persist partial or invalid blocks.
- On failure, use the active model's summary already supplied by the existing compression flow.
- Record only failure class, model identity, latency, and fallback usage; never log conversation or summary content.
- Ensure the external request cannot recursively trigger ACP compression.
- Preserve the current failure behavior if both the external and active summaries are unusable.

## Testing

### Core and property tests

- Configuration defaults and custom-value parsing.
- Role-preserving serialization of arbitrary message sequences.
- Prompt construction including range, topic, and fidelity rules.
- Response validation and failure classification.
- Lineage preservation for arbitrary message ranges.

### Adapter and integration tests

- Correct resolution of `openai-codex/gpt-5.6-luna:xhigh`.
- Successful external summary persistence.
- Fallback for timeout, authentication, rate-limit, empty, and invalid responses.
- No partial block after failure.
- No recursive compression invocation.
- Existing behavior unchanged when `compressionModel` is absent.

### Verification commands

```sh
npm test
npm run typecheck
npm run build
```

Real Luna calls are opt-in E2E tests and are not part of the default test suite.

## Rollout and compatibility

The fork will first be validated locally without changing Pi core. The default configuration for this fork will enable Luna routing, while the implementation retains an explicit fallback and allows users to disable the setting to recover upstream behavior. The change should remain isolated to the fork until tests and a manual E2E run pass.

## Open implementation detail

During implementation, identify the exact Pi model-resolution/streaming API available to this package and select the smallest adapter that uses it. Do not introduce a second credential or HTTP client path unless the host API makes provider reuse impossible.
