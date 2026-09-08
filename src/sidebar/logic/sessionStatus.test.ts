import { describe, it, expect } from "vitest";
import { deriveStatus, collectSignals, type RuntimeSignal } from "./sessionStatus";

const idl: RuntimeSignal = { busy: false, perm: null, hasMessages: false };

describe("会话状态推导（F-6-1）", () => {
  it("空闲 → idle", () => {
    expect(deriveStatus([idl])).toBe("idle");
  });

  it("工作中 → working", () => {
    expect(deriveStatus([{ ...idl, busy: true }])).toBe("working");
  });

  it("等批准 → awaiting_input（优先于 working）", () => {
    expect(deriveStatus([{ ...idl, busy: true, perm: { title: "read_file", options: [] } }])).toBe("awaiting_input");
  });

  it("有历史消息 → done", () => {
    expect(deriveStatus([{ ...idl, hasMessages: true }])).toBe("done");
  });

  it("无任何 runtime（纯历史会话未打开）→ done", () => {
    expect(deriveStatus([])).toBe("done");
  });

  it("多 runtime 聚合取最活跃（一个 waiting、一个 working）", () => {
    expect(
      deriveStatus([
        { ...idl, busy: true },
        { ...idl, perm: { title: "x", options: [] } },
      ]),
    ).toBe("awaiting_input");
  });

  it("collectSignals 把 tabs+状态信号聚合为 sessionId → 信号（P32 R2 投影签名）", () => {
    const signals = collectSignals(
      [
        { key: "k1", sessionId: "s-1" },
        { key: "k2", sessionId: "s-1" },
        { key: "k3" }, // 新建中（无 sessionId）
      ],
      {
        k1: { busy: true, perm: null, hasMessages: false },
        k2: { busy: false, perm: { title: "x", options: [] }, hasMessages: true },
      },
    );
    expect(signals.get("s-1")).toHaveLength(2);
    expect(signals.get("s-1")![0].busy).toBe(true);
    expect(signals.get("s-1")![1].hasMessages).toBe(true);
    expect(signals.has("s-1")).toBe(true);
  });
});
