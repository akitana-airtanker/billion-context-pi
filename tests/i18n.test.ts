import { test } from "node:test";
import assert from "node:assert/strict";
import { t, setLocale, locale, detectLocale } from "../src/i18n.js";

test("detectLocale returns zh when LANG starts with zh", () => {
  const old = { ...process.env };
  try {
    process.env.LANG = "zh_CN.UTF-8";
    delete process.env.LC_ALL;
    assert.equal(detectLocale(), "zh");
    process.env.LANG = "en_US.UTF-8";
    assert.equal(detectLocale(), "en");
  } finally {
    process.env = old;
  }
});

test("LC_ALL takes precedence over LANG", () => {
  const old = { ...process.env };
  try {
    process.env.LANG = "en_US.UTF-8";
    process.env.LC_ALL = "zh_TW.UTF-8";
    assert.equal(detectLocale(), "zh");
  } finally {
    process.env = old;
  }
});

test("setLocale override wins and resets to detection on undefined", () => {
  setLocale("zh");
  assert.equal(locale(), "zh");
  assert.match(t("blocks.none"), /尚未压缩/);
  setLocale(undefined);
  assert.ok(locale() === "zh" || locale() === "en");
});

test("t substitutes {name} placeholders with strings and numbers", () => {
  setLocale("en");
  assert.equal(
    t("context", { pct: 42, used: "10K", limit: "200K" }),
    "Context: 42% (10K / 200K)",
  );
  setLocale("zh");
  assert.equal(
    t("context", { pct: 42, used: "10K", limit: "200K" }),
    "上下文: 42% (10K / 200K)",
  );
});

test("zh and en tables differ for a representative key (translations present)", () => {
  setLocale("zh");
  const zhBlock = t("tag-visibility");
  setLocale("en");
  const enBlock = t("tag-visibility");
  assert.ok(zhBlock.length > 0 && enBlock.length > 0);
  assert.notEqual(zhBlock, enBlock);
});
