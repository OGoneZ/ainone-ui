import { describe, it, expect } from "vitest";
import { groupSessions } from "./workspaceGroup";
import type { Workspace } from "@/ipc/workspaces";
import type { SessionEntry } from "@/ipc/sessions";

const ws = (id: string, name: string, cwd: string): Workspace => ({
  id,
  name,
  cwd,
  created_ms: 1,
});

const se = (sid: string, wsid: string | null, mtime: number): SessionEntry => ({
  session_id: sid,
  adapter_id: "omp",
  title: "t",
  cwd: "",
  workspace_id: wsid,
  mtime_ms: mtime,
});

describe("侧栏工作区分组（F-5-1）", () => {
  it("工作区各归其组，未归组单独成组", () => {
    const groups = groupSessions(
      [ws("w1", "A", "/a"), ws("w2", "B", "/b")],
      [se("s1", "w1", 1), se("s2", "w1", 2), se("s3", "w2", 1), se("s4", null, 1)],
    );
    expect(groups).toHaveLength(3); // 2 工作区 + 1 未归组
    expect(groups[0].sessions.map((s) => s.session_id)).toEqual(["s2", "s1"]); // mtime 倒序
    expect(groups[2].workspace).toBeNull();
    expect(groups[2].sessions.map((s) => s.session_id)).toEqual(["s4"]);
  });

  it("空工作区仍占父级，未归组为空时不产出", () => {
    const groups = groupSessions([ws("w1", "A", "/a")], []);
    expect(groups).toHaveLength(1); // 只有空工作区
    expect(groups[0].sessions).toEqual([]);
  });

  it("无工作区、全部未归组 → 只有未归组组", () => {
    const groups = groupSessions([], [se("s1", null, 1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].workspace).toBeNull();
  });

  it("会话 workspace_id 指向不存在的工作区 → 落入未归组", () => {
    const groups = groupSessions([ws("w1", "A", "/a")], [se("s1", "ghost", 1)]);
    // workspace_id=ghost 不在工作区列表 → ungrouped
    const ungrouped = groups.find((g) => g.workspace === null);
    expect(ungrouped?.sessions.map((s) => s.session_id)).toEqual(["s1"]);
  });
});
