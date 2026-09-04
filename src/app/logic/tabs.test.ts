import { describe, it, expect } from "vitest";
import { findTabBySession, resolveHistoryOpen, type Tab } from "./tabs";

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
