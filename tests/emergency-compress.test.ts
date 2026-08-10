import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "acp-kernel";
import { resolveEmergencyCompressConfig } from "../src/compress-tool.js";
import { DEFAULT_EMERGENCY_MIN_COMPRESS_RANGE } from "../src/config.js";

const LIMIT = 200_000;
const base = () => defaultConfig(LIMIT);

test("resolveEmergencyCompressConfig leaves minCompressRange unchanged below the emergency threshold", () => {
  const cfg = resolveEmergencyCompressConfig(base(), 140_000, DEFAULT_EMERGENCY_MIN_COMPRESS_RANGE);
  assert.equal(cfg.compress.minCompressRange, 5000, "70% usage is below the 80% emergency gate");
});

test("resolveEmergencyCompressConfig lowers minCompressRange at/above the emergency threshold", () => {
  const cfg = resolveEmergencyCompressConfig(base(), 170_000, DEFAULT_EMERGENCY_MIN_COMPRESS_RANGE);
  assert.equal(cfg.compress.minCompressRange, DEFAULT_EMERGENCY_MIN_COMPRESS_RANGE, "85% usage triggers the relaxed 500-char floor");
});

test("resolveEmergencyCompressConfig is a no-op when the floor is not smaller than the base min", () => {
  const cfg = resolveEmergencyCompressConfig(base(), 190_000, 8000);
  assert.equal(cfg.compress.minCompressRange, 5000, "never raises the floor above the kernel default");
});

test("resolveEmergencyCompressConfig is disabled by emergencyFloor <= 0 even in emergency", () => {
  const cfg = resolveEmergencyCompressConfig(base(), 190_000, 0);
  assert.equal(cfg.compress.minCompressRange, 5000, "floor=0 opts out of relaxation entirely");
});

test("resolveEmergencyCompressConfig honors a custom emergencyThresholdPct override", () => {
  const cfg = defaultConfig(LIMIT, { nudge: { emergencyThresholdPct: 0.90 } });
  const atOld = resolveEmergencyCompressConfig(cfg, 170_000, DEFAULT_EMERGENCY_MIN_COMPRESS_RANGE);
  assert.equal(atOld.compress.minCompressRange, 5000, "85% is below the raised 90% threshold");
  const aboveNew = resolveEmergencyCompressConfig(cfg, 185_000, DEFAULT_EMERGENCY_MIN_COMPRESS_RANGE);
  assert.equal(aboveNew.compress.minCompressRange, DEFAULT_EMERGENCY_MIN_COMPRESS_RANGE, "92% clears the raised 90% threshold");
});

test("resolveEmergencyCompressConfig treats a zero modelContextLimit as never-emergency", () => {
  const cfg = defaultConfig(0);
  const out = resolveEmergencyCompressConfig(cfg, 1_000_000, DEFAULT_EMERGENCY_MIN_COMPRESS_RANGE);
  assert.equal(out.compress.minCompressRange, 5000, "undefined limit cannot compute usage → no relaxation");
});
