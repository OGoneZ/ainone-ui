// capability gate 判定矩阵单测（P24g）：规则编码的是 ACP 规格语义——
// 对象型能力 key presence = 支持（`{}` 即支持、null/省略即不支持）；
// 布尔型能力显式 false 才不支持（undefined = 老 harness 未声明，宽松尝试）。
// UI 显隐完全依赖这两个规则，判错会把「点了报错」变成「不显示入口」或反之。

import { describe, it, expect } from "vitest";
import { canFork, canLoad, canResume, canClose, canList, capabilitySnapshot } from "./capabilities";
import type { AgentCapabilities } from "@agentclientprotocol/sdk";

const cap = (partial: object) => partial as unknown as AgentCapabilities;

describe("canFork（对象型能力：key presence）", () => {
  it("fork: {} → 支持（AionUi 规则：空对象即声明支持）", () => {
    expect(canFork(cap({ sessionCapabilities: { fork: {} } }))).toBe(true);
  });

  it("fork: null / 省略 → 不支持（规格：Omitted or null both mean no support）", () => {
    expect(canFork(cap({ sessionCapabilities: { fork: null } }))).toBe(false);
    expect(canFork(cap({ sessionCapabilities: {} }))).toBe(false);
  });

  it("sessionCapabilities 整体省略 / capabilities 为 null → 不支持（旧 harness）", () => {
    expect(canFork(cap({}))).toBe(false);
    expect(canFork(null)).toBe(false);
    expect(canFork(undefined)).toBe(false);
  });
});

describe("canLoad（布尔型能力：显式 false 才否）", () => {
  it("loadSession: true / undefined → 允许（undefined = 老 harness 未声明，宽松尝试）", () => {
    expect(canLoad(cap({ loadSession: true }))).toBe(true);
    expect(canLoad(cap({}))).toBe(true);
  });

  it("loadSession: false → 不允许（与会话层降级预检同语义）", () => {
    expect(canLoad(cap({ loadSession: false }))).toBe(false);
  });

  it("capabilities 为 null → 允许（无法判定时不给功能降级添堵）", () => {
    expect(canLoad(null)).toBe(true);
  });
});

describe("canResume / canClose / canList（对象型能力：key presence，与 canFork 同规则）", () => {
  it("resume: {} / close: {} → 支持", () => {
    expect(canResume(cap({ sessionCapabilities: { resume: {} } }))).toBe(true);
    expect(canClose(cap({ sessionCapabilities: { close: {} } }))).toBe(true);
  });

  it("list: {} → 支持（P32d 会话列表入口 gate）", () => {
    expect(canList(cap({ sessionCapabilities: { list: {} } }))).toBe(true);
    expect(canList(cap({ sessionCapabilities: {} }))).toBe(false);
    expect(canList(cap({ sessionCapabilities: { list: null } }))).toBe(false);
    expect(canList(null)).toBe(false);
  });

  it("省略或 null → 不支持", () => {
    expect(canResume(cap({}))).toBe(false);
    expect(canClose(cap({ sessionCapabilities: { close: null } }))).toBe(false);
  });
});

describe("capabilitySnapshot（P32d：五布尔单一事实源）", () => {
  // 五家真机 initialize 实测样本（2026-09-08）：opencode 四能力全声明；
  // claude-code 声明 fork（loadSession=true）；omp/pi 未声明 sessionCapabilities。
  it("opencode 实测样本 → list/resume/close/fork 全 true", () => {
    const snap = capabilitySnapshot(cap({
      loadSession: true,
      sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
    }));
    expect(snap).toEqual({ fork: true, load: true, resume: true, close: true, list: true });
  });

  it("claude-code 实测样本（sessionCapabilities 仅 fork）→ 只 fork + load", () => {
    const snap = capabilitySnapshot(cap({ loadSession: true, sessionCapabilities: { fork: {} } }));
    expect(snap).toEqual({ fork: true, load: true, resume: false, close: false, list: false });
  });

  it("omp/pi 样本（无 sessionCapabilities）→ 全 false 但 load 宽松 true", () => {
    expect(capabilitySnapshot(cap({ loadSession: true }))).toEqual({
      fork: false, load: true, resume: false, close: false, list: false,
    });
    expect(capabilitySnapshot(null)).toEqual({
      fork: false, load: true, resume: false, close: false, list: false,
    });
  });
});
