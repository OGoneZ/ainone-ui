// P31 运行时诊断封装测试：mock invoke，验 IPC 透传与文案纯函数三态。

import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { runtimeDiagnostics, runtimeSummaryLine, type RuntimeDiagnostics } from "./runtime";

describe("runtimeDiagnostics IPC 封装", () => {
  beforeEach(() => invokeMock.mockReset());

  it("透传命令名并原样返回 Rust 结构", async () => {
    const snapshot: RuntimeDiagnostics = {
      bun: { path: "/usr/local/bin/bun", source: "system", version: "1.4.0" },
      npm: null,
      bundledDirExists: true,
      bundledShaVerified: true,
    };
    invokeMock.mockResolvedValue(snapshot);
    const d = await runtimeDiagnostics();
    expect(invokeMock).toHaveBeenCalledWith("runtime_diagnostics_cmd");
    expect(d).toEqual(snapshot);
  });

  it("reject 原样向上抛（调用方 catch 兜底文案）", async () => {
    invokeMock.mockRejectedValueOnce(new Error("boom"));
    try {
      await runtimeDiagnostics();
      expect.unreachable("应抛出 boom");
    } catch (e) {
      expect((e as Error).message).toBe("boom");
    }
  });
});

describe("runtimeSummaryLine 文案三态", () => {
  it("system bun + system npm → 双系统标注", () => {
    expect(
      runtimeSummaryLine({
        bun: { path: "/x/bun", source: "system", version: "1.4.0" },
        npm: { path: "/x/npm", source: "system", version: "10.9.4" },
        bundledDirExists: true,
        bundledShaVerified: null,
      }),
    ).toBe("运行时：bun 1.4.0（系统） · npm 10.9.4（系统）");
  });

  it("内嵌 bun 兜底 → 标注「内嵌」；npm 走 bundled-bun → 标注「bun 兜底」", () => {
    expect(
      runtimeSummaryLine({
        bun: { path: "/app/res/runtime/x/bun", source: "bundled", version: "1.3.4" },
        npm: { path: "/app/res/runtime/x/bun", source: "bundled-bun", version: "1.3.4" },
        bundledDirExists: true,
        bundledShaVerified: true,
      }),
    ).toBe("运行时：bun 1.3.4（内嵌） · npm 1.3.4（bun 兜底）");
  });

  it("version 缺失时不带版本号段；全缺 → 未找到文案；null → 未知", () => {
    expect(
      runtimeSummaryLine({
        bun: { path: "/x/bun", source: "bundled", version: null },
        npm: null,
        bundledDirExists: true,
        bundledShaVerified: false,
      }),
    ).toBe("运行时：bun（内嵌）");
    expect(
      runtimeSummaryLine({
        bun: null,
        npm: null,
        bundledDirExists: false,
        bundledShaVerified: null,
      }),
    ).toBe("运行时：未找到 bun / npm");
    expect(runtimeSummaryLine(null)).toBe("运行时：未知");
  });
});
