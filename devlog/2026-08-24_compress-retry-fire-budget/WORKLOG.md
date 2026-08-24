# WORKLOG: 压缩重试提示无限重注入（issue 重复刷屏）

- Task ID: `2026-08-24_compress-retry-fire-budget`
- Home Repo: `billion-context-pi`
- Status: InProgress
- Updated: 2026-08-24

## 1. Summary

- **What was done**: 新增 `MAX_RETRY_PROMPT_FIRES = 5` 注入预算——同一未处理失败的 `retryFor` 在预算烧尽后不再置位；`noteCompressOutcomes` 返回新增 `fires`/`exhaustedNow`；新接口 `compressRetryExhaustedFor(turnKey)` 把 exhausted 并入 emergency/nudge 的 alreadyShown 抑制；一次性日志 `compress-retry-exhausted` + UI notify；任何新 compress 结果或新用户轮重置预算。
- **Why**: billion-context#7 用户日志（0.1.41–0.1.47）显示"从不重试"的模型会让同一失败永远保持最新结果，重试提示每次 context fire 重注入（~400 次/小时，attempt 恒 1，usage 95→127%）。原 3 次封顶只数**不同**失败调用，对"零重试"模型不可达；emergency nudge 无任何预算约束。
- **Behavior / compatibility changes**: Yes——同一失败的重试提示从无限次降为 ≤5 次/轮；emergency nudge 在预算耗尽后同样静默（此前仅 retry-cap 抑制）。正常重试路径（每次新调用）不受影响。
- **Risk level**: Low

## 2. Change Log

### Commits

| Commit | Description |
|--------|-------------|
| (本分支) | fix(nudge): cap retry-prompt re-injections per unaddressed failure (fire budget) |

### Key files

- `src/runtime.ts` — `MAX_RETRY_PROMPT_FIRES`、`retryPromptFires`/`retryExhaustedNotified` 状态、`noteCompressOutcomes` 返回 `{count, retryFor, cappedNow, exhaustedNow, fires}`、`compressRetryExhaustedFor()`。
- `src/index.ts` — nudge 门控并入 exhausted 抑制（含 emergency 分支）；`compress-retry-inject` 日志带 `fires`/`fireMax`；`compress-retry-exhausted` 事件 + UI notify。
- `tests/compress-retry.test.ts` — 新增 3 个测试（unit 预算计数 / 集成 5 次封顶+新失败恢复 / issue #7 emergency 静默+恢复）。

## 3. Verification

- `npm run typecheck` ✅
- `npm test`：417 tests pass（含新增 3 项）✅
- `npm run build` ✅
- 复现路径回归：`emergency nudge quiets once the fire budget is burned by an ignored failure (issue #7 loop breaker)` ✅

## 4. Follow-ups

- 发版走 `*_release-v*` + CI（不手动 publish）；发版后在 billion-context#7 回访用户确认日志不再出现重复注入。
