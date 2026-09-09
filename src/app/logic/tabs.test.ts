import { describe, it, expect } from "vitest";
import { findTabBySession, resolveHistoryOpen, resolveTerminalCwd, type Tab } from "./tabs";

function tab(key: string, sessionId?: string): Tab {
  return { key, adapterId: "omp", sessionId, title: "t" };
}

const entry = (sid: string, adapterId: string, title: string) => ({
  session_id: sid,
  adapter_id: adapterId,
  title,
  cwd: "",
  workspace_id: null as string | null,
});

describe("会话去重与单实例（F-4-4）", () => {
  it("findTabBySession 命中已打开的 sessionId", () => {
    const tabs = [tab("k1", "s-1"), tab("k2", "s-2"), tab("k3")];
    expect(findTabBySession(tabs, "s-2")?.key).toBe("k2");
    expect(findTabBySession(tabs, "s-none")).toBeUndefined();
    expect(findTabBySession(tabs, undefined)).toBeUndefined();
  });

  it("同 sessionId 已打开 → 激活既有 Tab，不新开", () => {
    const tabs = [tab("k1", "s-1")];
    const r = resolveHistoryOpen(tabs, entry("s-1", "omp", "旧标题"), "k-new");
    expect(r.activateKey).toBe("k1");
    expect(r.newTab).toBeNull();
  });

  it("未打开 → 新开 Tab，绑定 sessionId 与 workspace", () => {
    const r = resolveHistoryOpen(
      [],
      { session_id: "s-9", adapter_id: "codex", title: "hi", cwd: "/proj", workspace_id: "w1" },
      "k-new",
    );
    expect(r.activateKey).toBe("k-new");
    expect(r.newTab).toEqual({
      key: "k-new",
      adapterId: "codex",
      sessionId: "s-9",
      title: "hi",
      cwd: "/proj",
      workspaceId: "w1",
    });
  });

  it("新建会话（无 sessionId）不参与去重", () => {
    const tabs = [tab("k1")]; // 新建中的 Tab 无 sessionId
    const r = resolveHistoryOpen(tabs, entry("s-5", "omp", "x"), "k2");
    expect(r.newTab).not.toBeNull();
  });
});

describe("终端 Tab（P23）", () => {
  it("kind 缺省 = agent（旧 Tab 兼容）", () => {
    const t = tab("k1", "s-1");
    expect(t.kind).toBeUndefined();
  });

  it("终端条目（kind=terminal）→ 新开 Tab 透传 kind", () => {
    const r = resolveHistoryOpen(
      [],
      {
        session_id: "term-tab-1",
        adapter_id: "terminal",
        title: "终端",
        cwd: "/proj",
        workspace_id: null,
        kind: "terminal",
      },
      "k-new",
    );
    expect(r.newTab).toEqual({
      key: "k-new",
      adapterId: "terminal",
      sessionId: "term-tab-1",
      title: "终端",
      cwd: "/proj",
      workspaceId: null,
      kind: "terminal",
    });
  });

  it("agent 条目无 kind 字段也不受影响（投影补 agent）", () => {
    const r = resolveHistoryOpen([], entry("s-9", "omp", "x"), "k-new");
    expect(r.newTab?.kind).toBeUndefined();
    expect(r.newTab?.adapterId).toBe("omp");
  });
});

// —— P36 R4：resolveTerminalCwd 兜底解析 ——
describe("resolveTerminalCwd（P36 R4）", () => {
  const workspaces = [
    { id: "ws-1", cwd: "/home/u/proj" },
    { id: "ws-2", cwd: "/home/u/other" },
  ];

  it("cwd 非空直用（优先级最高）", () => {
    expect(resolveTerminalCwd("/x", "ws-1", workspaces)).toBe("/x");
    expect(resolveTerminalCwd("/x", null, workspaces)).toBe("/x");
  });

  it("cwd 空串/undefined → workspaceId 反查 workspaces.cwd", () => {
    expect(resolveTerminalCwd("", "ws-2", workspaces)).toBe("/home/u/other");
    expect(resolveTerminalCwd(undefined, "ws-1", workspaces)).toBe("/home/u/proj");
  });

  it("cwd 与 workspaceId 都无效 → undefined（调用方 fail loud）", () => {
    expect(resolveTerminalCwd("", null, workspaces)).toBeUndefined();
    expect(resolveTerminalCwd("", "ws-missing", workspaces)).toBeUndefined();
    expect(resolveTerminalCwd("", "ws-1", undefined)).toBeUndefined();
  });

  it("AC-4.3 resolveHistoryOpen 历史终端条目 cwd 空串 + workspace_id → 反查兜底", () => {
    const r = resolveHistoryOpen(
      [],
      {
        session_id: "term-tab-1",
        adapter_id: "terminal",
        title: "终端",
        cwd: "",
        workspace_id: "ws-1",
        kind: "terminal",
      },
      "k-new",
      workspaces,
    );
    expect(r.newTab?.cwd).toBe("/home/u/proj");
  });
});
