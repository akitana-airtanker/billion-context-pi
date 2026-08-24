# REQ: 压缩重试提示无限重注入（issue 重复刷屏）

- Task ID: `2026-08-24_compress-retry-fire-budget`
- Home Repo: `billion-context-pi`
- Created: 2026-08-24
- Status: InProgress
- Priority: P1
- Owner: ework-daemon
- References: issue dog/billion-context#7

## 1. Background & Problem Statement

- **Context**: compress 失败后的重试提示（`compress-retry-inject`）设计为"每次 context 事件重新注入，直到模型重试"（pi 每次重建上下文，一次性 append 会消失）。
- **Current behavior (symptom)**: 用户日志（billion-context#7，billion-context-pi 0.1.41–0.1.47，本地 GGUF 模型 qwen3.8-27b）显示同一 `toolCallId` 的失败被连续重注入 ~400 次/小时（08-23 10:14–11:15+），`attempt` 恒为 1，`emergency-inject` 的 pct 从 95 爬到 127。模型收到重试提示后**从不重试**（不再产生任何新 compress 调用），同一失败永远是"最新结果"，`retryFor` 每次 fire 都置位 → 无限重注入；封顶（`MAX_COMPRESS_ATTEMPTS=3`）只有出现 3 个**不同**的失败调用才可达。emergency nudge 只受 retry-cap 抑制，不受任何注入预算约束，加剧循环。
- **Expected behavior**:
  - 同一未处理的失败最多重注入 `MAX_RETRY_PROMPT_FIRES = 5` 次；预算烧完后静默（日志 `compress-retry-exhausted` 一次性记录 + UI 提示），emergency nudge 同步静默。
  - 任何**新的** compress 结果（成功/失败/no-op）重置预算并解除静默；下一用户轮照常重置。
  - 封顶语义（3 个不同失败）不变；turnKey 作用域不变。
- **Impact**: 修复后最坏情况从无限重注入降为 5 次；正常重试路径（模型每次产生新调用）行为不变。

## 2. Reproduction

- **Environment**: win32、本地 openai-completions provider（非严格工具）、小模型不重试 compress。
- **Minimal reproduction steps**:
  1) 注入大上下文触发 compress nudge；
  2) 模型发起一次失败的 compress 调用（如 content 传 JSON 字符串）；
  3) 模型之后**忽略**所有重试提示（无新调用）；
  4) 每次 LLM 调用 context fire 都再注入一条重试提示 → 刷屏 + usage 虚高。
- 集成测试 `emergency nudge quiets once the fire budget is burned by an ignored failure` 复现该路径。

## 3. Constraints & Non-Goals

- **Constraints**: 不引入新依赖；不改变重试提示文案语义（attempt N of M 不变）；不改变 3 次封顶与 per-turn 重置。
- **Non-Goals**: 不解决"模型为什么失败"（stale refs / JSON 字符串参数已有各自修复）；不做指数退避（固定预算足够）。

## 4. Acceptance Criteria (must be testable)

1. 单元：同一 `toolCallId` 失败重复 fire，`retryFor` 非空次数 = `MAX_RETRY_PROMPT_FIRES`，之后为 null 且 `compressRetryExhaustedFor(turnKey)` 为 true（per-turn）。
2. 单元：预算耗尽后出现**新**失败 → count 递增、预算重置、exhausted 解除。
3. 集成：一条失败 + N>预算次 fire → 重试提示恰好出现 MAX 次，之后静默；新失败恢复 attempt 2。
4. 集成：emergency nudge 在预算烧完后不再重注入；新 compress 结果（即使 no-op）恢复 guidance。
5. 全量 `npm test` 通过（417+ tests）、`npm run typecheck`、`npm run build` 通过。
