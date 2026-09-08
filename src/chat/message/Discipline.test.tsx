// @vitest-environment jsdom
// P32 AC-2.x：工具块折叠纪律——diff 默认展开且跨分组迁移不回折 + 用户操作不被翻转。
// 意图（WHY）：P30 实机「一会儿展开一会儿收起」= 组边界移动导致块在独立↔组卡间翻转 +
// 位置 key 重挂丢 state。P32 修复 = 流式不收组（S1）+ 稳定键 + 组级 defaultOpen；
// 本测试以「分组结构变化前后块状态不变」为核心断言。

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
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

const tool = (over: Partial<Extract<BlockMsg, { kind: "tool" }>>): BlockMsg => ({
  kind: "tool",
  toolCallId: "t1",
  title: "Edit",
  status: "in_progress",
  content: [],
  ...over,
});
const bash = (over: Partial<Extract<BlockMsg, { kind: "tool" }>>): BlockMsg =>
  tool({ title: "Bash", ...over });

function renderMsg(blocks: BlockMsg[], streaming: boolean) {
  const msg: ChatMsg = { role: "assistant", blocks };
  useSessionStore.setState({ runtime: {}, commands: {} });
  return render(<MessageLine msg={msg} adapter={adapter} busy={streaming} isLast={streaming} />);
}

function rerenderMsg(view: ReturnType<typeof render>, blocks: BlockMsg[], streaming = true) {
  const msg: ChatMsg = { role: "assistant", blocks };
  view.rerender(<MessageLine msg={msg} adapter={adapter} busy={streaming} isLast={streaming} />);
}

describe("工具块默认折叠/展开（P32 AC-2.1/2.2）", () => {
  it("AC-2.1：无 diff 工具块流式中始终折叠（头部可见、内容不可见）", () => {
    renderMsg([bash({ toolCallId: "b0", status: "in_progress", content: [{ kind: "text", text: "stdout 内容" }] })], true);
    expect(screen.getByText("Bash")).toBeTruthy(); // 头部
    expect(screen.queryByText("stdout 内容")).toBeNull(); // 内容折叠
  });

  it("AC-2.2：content 含 diff 的工具块首次渲染即展开", () => {
    renderMsg(
      [tool({ status: "in_progress", content: [{ kind: "diff", diff: { path: "/w.ts", oldText: "", newText: "n" } }] })],
      true,
    );
    expect(screen.getByText("/w.ts")).toBeTruthy();
  });
});

describe("分组迁移不回折（P32 AC-2.4/2.6）", () => {
  it("AC-2.4：diff 块从独立渲染迁移进组卡（新块到达引发重组）→ 展开态保持", () => {
    // P32 流式不收组 + 稳定键：任何帧变化 diff 块都不回折
    const view = renderMsg(
      [tool({ toolCallId: "edit1", status: "completed", ms: 100, content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "", newText: "n" } }] })],
      true,
    );
    expect(screen.getByText("/a.ts")).toBeTruthy();
    // 新 tool 到达（旧实现此时边界移动会把 edit1 收进折叠卡）
    rerenderMsg(view, [
      tool({ toolCallId: "edit1", status: "completed", ms: 100, content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "", newText: "n" } }] }),
      tool({ toolCallId: "bash2", title: "Bash", status: "in_progress", content: [] }),
    ]);
    expect(screen.getByText("/a.ts")).toBeTruthy();
    // diff 边沿重复触发也不折腾（update 重放场景）
    rerenderMsg(view, [
      tool({ toolCallId: "edit1", status: "completed", ms: 100, content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "", newText: "n" } }] }),
      tool({ toolCallId: "bash2", title: "Bash", status: "completed", ms: 50, content: [] }),
    ]);
    expect(screen.getByText("/a.ts")).toBeTruthy();
  });

  it("AC-2.6：turn 结束全量收组 → 含 diff 组卡默认展开、组内 diff 块展开；无 diff 组折叠", () => {
    const blocks = [
      tool({ toolCallId: "edit1", status: "completed", ms: 100, content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "", newText: "n" } }] }),
      tool({ toolCallId: "bash1", title: "Bash", status: "completed", ms: 50, content: [{ kind: "text", text: "ok" }] }),
    ];
    const view = renderMsg(blocks, true);
    // 收组（busy=false 切 buildActivityGroups）
    rerenderMsg(view, blocks, false);
    // 组默认展开（含 diff）→ diff 直接可见
    expect(screen.getByText("/a.ts")).toBeTruthy();
    // 无 diff 块仍折叠
    expect(screen.queryByText("ok")).toBeNull();
  });

  it("无 diff 组卡 turn 结束收组后默认折叠；展开组后组内无 diff 块仍折叠（AC-2.1）", () => {
    const blocks = [
      { kind: "thought", text: "想一想", ms: 100 } as BlockMsg,
      tool({ toolCallId: "bash1", title: "Bash", status: "completed", ms: 50, content: [{ kind: "text", text: "ok" }] }),
    ];
    renderMsg(blocks, false);
    expect(screen.queryByText("ok")).toBeNull(); // 组折叠
    // 展开组卡：组体可见（Bash 头部行出现），但组内无 diff 块仍保持自身折叠纪律
    fireEvent.click(screen.getByText(/工具 1 个/));
    expect(screen.getByText("Bash")).toBeTruthy();
    expect(screen.queryByText("ok")).toBeNull();
  });
});

describe("用户操作不被翻转（P32 AC-2.5）", () => {
  it("AC-2.5：用户手动收起 diff 块 → 后续流式更新不重新展开", () => {
    const blocks = [
      tool({ toolCallId: "edit1", status: "completed", ms: 100, content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "", newText: "n" } }] }),
    ];
    const view = renderMsg(blocks, true);
    expect(screen.getByText("/a.ts")).toBeTruthy();
    // 手动收起
    fireEvent.click(screen.getByText("Edit"));
    expect(screen.queryByText("/a.ts")).toBeNull();
    // 后续更新（同块引用变化）
    rerenderMsg(view, [
      tool({ toolCallId: "edit1", status: "completed", ms: 100, content: [{ kind: "diff", diff: { path: "/a.ts", oldText: "", newText: "n2" } }] }),
    ]);
    expect(screen.queryByText("/a.ts")).toBeNull(); // 不被强开
  });
});
