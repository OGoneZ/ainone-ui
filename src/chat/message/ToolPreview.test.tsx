// @vitest-environment jsdom
// P36 R3 AC-3.1/3.2/3.5 + R5 AC-3.3：写操作工具卡「预览文件」按钮——渲染条件、
// 事件载荷 {path, tabKey}、stopPropagation 不改折叠态、监听归属判定。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageLine } from "./MessageLine";
import { useSessionStore, type ChatMsg } from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";
import type { BlockMsg } from "@/acp/message-log";

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => cleanup());

const adapter: AdapterWithStatus = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

function renderMsg(blocks: BlockMsg[], ownerTabKey?: string) {
  const msg: ChatMsg = { role: "assistant", blocks };
  useSessionStore.setState({ runtime: {}, commands: {} });
  render(<MessageLine msg={msg} adapter={adapter} busy={false} isLast={false} ownerTabKey={ownerTabKey} />);
}

const toolBlock = (over: Partial<Extract<BlockMsg, { kind: "tool" }>>): BlockMsg => ({
  kind: "tool",
  toolCallId: "t1",
  title: "Terminal",
  status: "completed",
  content: [],
  ...over,
});

describe("P36 R3 预览文件按钮", () => {
  it("AC-3.1 含 diff 的工具卡有预览按钮；execute/无目标 read 无", () => {
    renderMsg([
      toolBlock({
        status: "in_progress",
        toolKind: "edit",
        content: [{ kind: "diff", diff: { path: "/a/b.ts", oldText: "x", newText: "y" } }],
      }),
    ]);
    expect(screen.getByRole("button", { name: "预览 /a/b.ts" })).toBeTruthy();
    cleanup();

    renderMsg([
      toolBlock({ status: "in_progress", toolKind: "execute", rawInput: { command: "ls" } }),
    ]);
    expect(screen.queryByRole("button", { name: /预览 / })).toBeNull();
    cleanup();

    renderMsg([toolBlock({ status: "in_progress", toolKind: "read", content: [] })]);
    expect(screen.queryByRole("button", { name: /预览 / })).toBeNull();
  });

  it("AC-3.2 rawInput.file_path（claude 系）/path（omp 系）均可命中", () => {
    renderMsg([toolBlock({ status: "in_progress", toolKind: "edit", rawInput: { file_path: "/x/a.ts" } })]);
    expect(screen.getByRole("button", { name: "预览 /x/a.ts" })).toBeTruthy();
    cleanup();

    renderMsg([toolBlock({ status: "in_progress", toolKind: "edit", rawInput: { path: "/x/b.ts" } })]);
    expect(screen.getByRole("button", { name: "预览 /x/b.ts" })).toBeTruthy();
  });

  it("AC-3.2 点击 dispatch ainone:open-file detail={path, tabKey}；不改折叠态", () => {
    const dispatched: CustomEvent[] = [];
    const spy = (e: Event) => dispatched.push(e as CustomEvent);
    window.addEventListener("ainone:open-file", spy);

    renderMsg(
      [
        toolBlock({
          status: "in_progress",
          toolKind: "edit",
          rawInput: { file_path: "/x/a.ts" },
          content: [{ kind: "text", text: "expanded body" }],
        }),
      ],
      "tab-9",
    );
    // 先点开折叠卡（in_progress 独立渲染默认折叠）
    fireEvent.click(screen.getByText("Terminal"));
    expect(screen.getByText("expanded body")).toBeTruthy();
    // 点预览钮：折叠态保持展开
    fireEvent.click(screen.getByRole("button", { name: "预览 /x/a.ts" }));
    expect(screen.getByText("expanded body")).toBeTruthy();

    expect(dispatched).toHaveLength(1);
    expect((dispatched[0].detail as { path: string; tabKey: string }).path).toBe("/x/a.ts");
    expect((dispatched[0].detail as { path: string; tabKey: string }).tabKey).toBe("tab-9");
    window.removeEventListener("ainone:open-file", spy);
  });

  it("AC-3.5 FileChangeRow 同样有预览按钮，事件带 {path, tabKey}", () => {
    const dispatched: CustomEvent[] = [];
    const spy = (e: Event) => dispatched.push(e as CustomEvent);
    window.addEventListener("ainone:open-file", spy);

    renderMsg(
      [
        toolBlock({
          status: "completed",
          ms: 1000,
          content: [{ kind: "diff", diff: { path: "/g/c.ts", oldText: "1\n2", newText: "1\n2\n3" } }],
        }),
      ],
      "tab-7",
    );
    // completed 块收进活动组；组含 diff 默认展开，文件变更行直接可见。
    // 同路径在组头 ToolBlock 与 FileChangeRow 各有一个预览钮（两条渲染路径）——
    // 两个都触发、事件各带 {path, tabKey}
    const rows = screen.getAllByRole("button", { name: "预览 /g/c.ts" });
    expect(rows.length).toBe(2);
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    expect(dispatched).toHaveLength(2);
    expect((dispatched[0].detail as { path: string; tabKey: string }).tabKey).toBe("tab-7");
    expect((dispatched[1].detail as { path: string; tabKey: string }).tabKey).toBe("tab-7");
    window.removeEventListener("ainone:open-file", spy);
  });
});
