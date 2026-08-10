import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, resolveEffectiveContextLimit, type AdapterConfig } from "../src/config.js";

const EMPTY: AdapterConfig = {};

test("resolveConfig uses the live model context window as-is (no cap on large windows)", () => {
  const cfg = resolveConfig(EMPTY, 1_000_000);
  assert.equal(cfg.modelContextLimit, 1_000_000, "1M window must NOT be capped to 150K");
});

test("resolveConfig passes small windows through unchanged too", () => {
  assert.equal(resolveConfig(EMPTY, 32_000).modelContextLimit, 32_000);
  assert.equal(resolveConfig(EMPTY, 200_000).modelContextLimit, 200_000);
});

test("resolveConfig falls back to 150K only when the live window is unavailable", () => {
  assert.equal(resolveConfig(EMPTY, 0).modelContextLimit, 150_000);
});

test("resolveConfig prefers adapter.modelContextLimit over the live window", () => {
  const cfg = resolveConfig({ modelContextLimit: 500_000 }, 1_000_000);
  assert.equal(cfg.modelContextLimit, 500_000);
});

test("resolveConfig prefers ACP_MODEL_CONTEXT_LIMIT env var over everything", () => {
  const prev = process.env.ACP_MODEL_CONTEXT_LIMIT;
  process.env.ACP_MODEL_CONTEXT_LIMIT = "999999";
  try {
    const cfg = resolveConfig({ modelContextLimit: 500_000 }, 1_000_000);
    assert.equal(cfg.modelContextLimit, 999_999);
  } finally {
    if (prev === undefined) delete process.env.ACP_MODEL_CONTEXT_LIMIT;
    else process.env.ACP_MODEL_CONTEXT_LIMIT = prev;
  }
});

test("resolveConfig ignores a non-positive ACP_MODEL_CONTEXT_LIMIT and falls through", () => {
  const prev = process.env.ACP_MODEL_CONTEXT_LIMIT;
  process.env.ACP_MODEL_CONTEXT_LIMIT = "0";
  try {
    const cfg = resolveConfig(EMPTY, 1_000_000);
    assert.equal(cfg.modelContextLimit, 1_000_000, "env=0 must fall through to live window, not 0");
  } finally {
    if (prev === undefined) delete process.env.ACP_MODEL_CONTEXT_LIMIT;
    else process.env.ACP_MODEL_CONTEXT_LIMIT = prev;
  }
});

test("resolveEffectiveContextLimit reconstructs the real window from provider percent", () => {
  // 36072 tokens at 13.26% ⇒ real window ≈ 272000 (the acp.log scenario).
  assert.equal(resolveEffectiveContextLimit(80_000, { percent: 0.1326 }, 36_072), 272_036);
  assert.equal(resolveEffectiveContextLimit(80_000, { tokens: 70_000, percent: 0.2574 }, 70_000), 271_950);
});

test("resolveEffectiveContextLimit falls back to configured when reading is unreliable", () => {
  assert.equal(resolveEffectiveContextLimit(80_000, undefined, 36_072), 80_000, "no reading");
  assert.equal(resolveEffectiveContextLimit(80_000, { percent: null }, 36_072), 80_000, "null percent");
  assert.equal(resolveEffectiveContextLimit(80_000, { percent: 0.03 }, 36_072), 80_000, "percent below 5% band");
  assert.equal(resolveEffectiveContextLimit(80_000, { percent: 1.5 }, 220_000), 80_000, "percent above 100% (overflow, skip)");
  assert.equal(resolveEffectiveContextLimit(80_000, { percent: 0.5 }, 0), 80_000, "zero tokenCount");
});

test("resolveEffectiveContextLimit accepts exactly 100%", () => {
  assert.equal(resolveEffectiveContextLimit(80_000, { percent: 1 }, 200_000), 200_000);
});
