// F-15-3 外部拖入载荷逻辑单测（DEC-43）：暂存/取出/清理/投影。

import { describe, expect, it } from "vitest";
import {
  setExternalDragPayload,
  takeExternalDragPayload,
  clearExternalDragPayload,
  hasExternalDragPayload,
  payloadToTab,
  type ExternalDragPayload,
} from "./externalDrag";

const P: ExternalDragPayload = {
  sessionId: "s-1",
  adapterId: "omp",
  title: "修 bug 会话",
  cwd: "/home/u/proj",
  workspaceId: "ws-9",
};

describe("externalDrag 暂存通道", () => {
  it("set → take 原样取出，且取后清空（同载荷不会被消费两次）", () => {
    setExternalDragPayload(P);
    expect(hasExternalDragPayload()).toBe(true);
    expect(takeExternalDragPayload()).toEqual(P);
    expect(hasExternalDragPayload()).toBe(false);
    expect(takeExternalDragPayload()).toBeNull();
  });

  it("无暂存时 take 返回 null", () => {
    clearExternalDragPayload();
    expect(takeExternalDragPayload()).toBeNull();
  });

  it("重复 set 覆盖旧载荷（同一时刻至多一个拖拽）", () => {
    setExternalDragPayload(P);
    setExternalDragPayload({ ...P, sessionId: "s-2" });
    expect(takeExternalDragPayload()?.sessionId).toBe("s-2");
  });

  it("clear 兜底清理", () => {
    setExternalDragPayload(P);
    clearExternalDragPayload();
    expect(hasExternalDragPayload()).toBe(false);
  });
});

describe("payloadToTab 投影", () => {
  it("字段完整投影：sessionId/cwd/workspaceId 进 Tab", () => {
    const t = payloadToTab(P, "tab-7");
    expect(t).toEqual({
      key: "tab-7",
      adapterId: "omp",
      sessionId: "s-1",
      title: "修 bug 会话",
      cwd: "/home/u/proj",
      workspaceId: "ws-9",
    });
  });

  it("空 cwd → undefined（未开目录会话）", () => {
    const t = payloadToTab({ ...P, cwd: "", workspaceId: null }, "tab-8");
    expect(t.cwd).toBeUndefined();
    expect(t.workspaceId).toBeNull();
  });
});
