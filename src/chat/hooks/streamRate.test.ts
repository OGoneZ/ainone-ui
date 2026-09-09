// P37 R1：速率计算器单测。
// 意图：速率是「感知模型快慢」的估算指标——匀速流必须收敛到真实速率附近
// （±20%），CJK/英文混合要按占比插值换算；窗口滑出旧样本、样本不足不显示、
// EMA 抑制突发抖动；finalize 有权威终值走精确均值、无则冻结估算；长流内存有界。

import { describe, it, expect } from "vitest";
import { createStreamRate } from "./streamRate";

describe("createStreamRate（P37 输出速率估算）", () => {
  it("匀速英文流收敛到真实速率附近（±20%）", () => {
    let t = 0;
    const rate = createStreamRate();
    // 每 250ms 到达 100 字符（英文 ≈4 字符/token → 25 token/250ms = 100 tok/s）
    for (let i = 0; i < 60; i++) {
      t += 250;
      rate.onChunk("a".repeat(100), t);
    }
    const r = rate.rate(t);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(80); // 100 × 0.8
    expect(r!).toBeLessThan(120); // 100 × 1.2
  });

  it("纯中文流按 1.5 字/token 换算（英文换算会低估速率 2.7 倍）", () => {
    let t = 0;
    const rate = createStreamRate();
    // 每 500ms 到达 60 个中文字符（≈40 token → 80 tok/s 真值）
    for (let i = 0; i < 40; i++) {
      t += 500;
      rate.onChunk("中".repeat(60), t);
    }
    const r = rate.rate(t)!;
    expect(r).toBeGreaterThan(60); // 80 × 0.75
    expect(r).toBeLessThan(100); // 80 × 1.25
  });

  it("混合文本按 CJK 占比插值（介于两端点之间）", () => {
    let t = 0;
    const rate = createStreamRate();
    // 一半中文一半英文：charsPerToken ≈ 2.75
    const text = "中".repeat(50) + "a".repeat(50);
    for (let i = 0; i < 40; i++) {
      t += 500;
      rate.onChunk(text, t);
    }
    const r = rate.rate(t)!;
    expect(r).toBeGreaterThan(0);
    // 混合占比下速率介于「按英文算」与「按中文算」之间
    // 每 500ms：100 字符。按英文 25 tok，按中文 ≈66 tok
    expect(r).toBeGreaterThan(15);
    expect(r).toBeLessThan(80);
  });

  it("窗口滑出旧样本：停流 10s 后速率归 null（不显示陈旧速率）", () => {
    let t = 0;
    const rate = createStreamRate();
    for (let i = 0; i < 10; i++) {
      t += 250;
      rate.onChunk("word ".repeat(20), t);
    }
    expect(rate.rate(t)).not.toBeNull();
    t += 10_001; // 停流超过窗口
    expect(rate.rate(t)).toBeNull();
  });

  it("窗口内字符 < 20 → null（首字前不显示 0 tok/s 跳动）", () => {
    let t = 0;
    const rate = createStreamRate();
    t += 100;
    rate.onChunk("hi", t); // 2 字符
    expect(rate.rate(t)).toBeNull();
    t += 100;
    rate.onChunk(" more text arrives here", t); // 超过 20 字符
    expect(rate.rate(t)).not.toBeNull();
  });

  it("EMA 抑制突发抖动：单次 10 倍突发不把显示值打飞", () => {
    let t = 0;
    const rate = createStreamRate();
    // 稳态 100 tok/s
    for (let i = 0; i < 20; i++) {
      t += 250;
      rate.onChunk("a".repeat(100), t);
    }
    const steady = rate.rate(t)!;
    // 单次 10 倍突发
    t += 250;
    rate.onChunk("a".repeat(1000), t);
    const after = rate.rate(t)!;
    // EMA 0.35：突发的 10 倍尖峰只拉高 35%，显示值仍接近稳态
    expect(after).toBeLessThan(steady * 2);
  });

  it("finalize 有权威终值 → 精确均值（outputTokens ÷ 墙钟）", () => {
    let t = 0;
    const rate = createStreamRate();
    t = 1000;
    rate.onChunk("a".repeat(40), t);
    t = 11_000; // 10s 后收口
    rate.finalize(500, t); // 500 token / 10s = 50 tok/s
    expect(rate.display(t)).toBeCloseTo(50, 0);
  });

  it("finalize 无终值 → 冻结最后估算 EMA", () => {
    let t = 0;
    const rate = createStreamRate();
    for (let i = 0; i < 20; i++) {
      t += 250;
      rate.onChunk("a".repeat(100), t);
    }
    const lastEstimate = rate.rate(t)!;
    t += 500;
    rate.finalize(null, t);
    expect(rate.display(t)).toBeCloseTo(lastEstimate, 0);
  });

  it("无任何 chunk 的 turn（纯 tool）→ finalize 后仍 null（不渲染 badge）", () => {
    let t = 0;
    const rate = createStreamRate();
    t = 5000;
    rate.finalize(null, t);
    expect(rate.display(t)).toBeNull();
  });

  it("样本上限 200：长流丢弃最旧样本（内存有界）+ 速率仍收敛", () => {
    let t = 0;
    const rate = createStreamRate();
    for (let i = 0; i < 500; i++) {
      t += 250; // 500 条 ≫ 200 上限
      rate.onChunk("a".repeat(100), t);
    }
    const r = rate.rate(t)!;
    expect(r).not.toBeNull();
    expect(r).toBeGreaterThan(80); // 持续流下速率不因丢样本失真
    expect(r).toBeLessThan(120);
  });

  it("reset 清空全部状态（下轮 turn 归零重走）", () => {
    let t = 0;
    const rate = createStreamRate();
    for (let i = 0; i < 10; i++) {
      t += 250;
      rate.onChunk("a".repeat(100), t);
    }
    rate.finalize(null, t);
    expect(rate.display(t)).not.toBeNull();
    rate.reset();
    expect(rate.display(t)).toBeNull();
  });

  it("收口后 onChunk 不污染冻结值（异常流残余事件）", () => {
    let t = 0;
    const rate = createStreamRate();
    t = 1000;
    rate.onChunk("a".repeat(40), t);
    t = 11_000;
    rate.finalize(400, t); // 40 tok/s
    t += 1000;
    rate.onChunk("a".repeat(10_000), t); // 收口后的残余事件
    expect(rate.display(t)).toBeCloseTo(40, 0);
  });
});
