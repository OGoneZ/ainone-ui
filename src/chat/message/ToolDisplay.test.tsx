// @vitest-environment jsdom
// P30 AC-2.3/2.4：ToolBlock kind 图标/副标题/中文状态 + 活动组卡折叠态文件变更徽标。

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
  id: "claude-code",
  name: "Claude Code",
  program: "claude-agent-acp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true,
  resolvedPath: null,
  source: null,
};

/** 渲染消息，可选先展开活动组卡（已完成 tool 块默认入组折叠） */
function renderMsg(blocks: BlockMsg[], { expandGroup = false } = {}) {
  const msg: ChatMsg = { role: "assistant", blocks };
  useSessionStore.setState({ runtime: {}, commands: {} });
  const view = render(
    <MessageLine msg={msg} adapter={adapter} busy={false} isLast={false} />,
  );
  if (expandGroup) {
    for (const btn of screen.queryAllByText(/工具 \d+ 个|思考 \d+ 次/)) fireEvent.click(btn);
  }
  return view;
}

const toolBlock = (over: Partial<Extract<BlockMsg, { kind: "tool" }>>): BlockMsg => ({
  kind: "tool",
  toolCallId: "t1",
  title: "Terminal",
  status: "completed",
  content: [],
  ...over,
});

describe("ToolBlock 细化显示（P30 AC-2.3）", () => {
  it("头部渲染 kind 参数副标题（rawInput.command）与中文状态（运行中块独立渲染不入组）", () => {
    renderMsg([
      toolBlock({ status: "in_progress", toolKind: "execute", rawInput: { command: "git status" } }),
    ]);
    expect(screen.getByText("git status")).toBeTruthy();
    expect(screen.getByText("运行中")).toBeTruthy();
  });

  it("failed 状态显示「失败」（completed 块入组，展开组可见）", () => {
    renderMsg([toolBlock({ status: "failed" })], { expandGroup: true });
    expect(screen.getByText("失败")).toBeTruthy();
  });

  it("活动组展开后可见副标题与中文状态；旧日志无 toolKind 不渲染副标题", () => {
    renderMsg([toolBlock({ status: "failed" })], { expandGroup: true });
    expect(screen.getByText("失败")).toBeTruthy();
    expect(screen.queryByText("git status")).toBeNull();
  });

  it("file_path rawInput → 副标题显示文件名 + 中文「完成」（组内）", () => {
    renderMsg(
      [toolBlock({ toolKind: "edit", rawInput: { file_path: "/a/b/DeepChat.ts" } })],
      { expandGroup: true },
    );
    expect(screen.getByText("DeepChat.ts")).toBeTruthy();
    expect(screen.getByText("完成")).toBeTruthy();
  });

  it("P30 AC-2.1：含 diff 的工具块在组内展开时 diff 可见", () => {
    renderMsg(
      [
        toolBlock({
          status: "completed",
          content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "old", newText: "new" } }],
        }),
      ],
      { expandGroup: true },
    );
    expect(screen.getByText("/a.ts")).toBeTruthy();
  });

  it("P30 AC-2.1：运行中含 diff 的工具块独立渲染且默认展开", () => {
    renderMsg([
      toolBlock({
        status: "in_progress",
        content: [{ kind: "diff", diff: { path: "/live.ts", oldText: "", newText: "new" } }],
      }),
    ]);
    expect(screen.getByText("/live.ts")).toBeTruthy();
  });

  it("无 diff 的运行中工具块默认折叠", () => {
    renderMsg([toolBlock({ status: "in_progress", content: [{ kind: "text", text: "stdout" }] })]);
    expect(screen.queryByText("stdout")).toBeNull();
  });
});

describe("活动组卡折叠态文件变更徽标（P30 AC-2.4）", () => {
  it("组内有 diff → 折叠态摘要行显示 +N −N M 个文件", () => {
    renderMsg([
      { kind: "text", text: "正文" },
      toolBlock({
        status: "completed",
        ms: 1000,
        content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "1\n2", newText: "1\n2\n3" } }],
      }),
    ]);
    // 折叠态（默认）摘要行可见：+2 −1 1 个文件（oldText 2 行 vs newText 3 行 → +2/−1）
    // 「1」与「个文件」是分开的文本节点，用正则匹配
    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
    expect(screen.getByText(/个文件/)).toBeTruthy();
  });

  it("组内无 diff → 不显示徽标", () => {
    renderMsg([toolBlock({ status: "completed", ms: 500, content: [{ kind: "text", text: "x" }] })]);
    expect(screen.queryByText("个文件")).toBeNull();
  });
});
