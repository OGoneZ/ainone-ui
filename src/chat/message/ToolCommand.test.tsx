// @vitest-environment jsdom
// P36 R1 AC-1.1/1.2/1.3/1.6：execute 类工具两段式展开——命令段全文 + 复制钮 +
// 输出兜底链（content text → rawOutput → 仅命令段）；非 execute 不渲染命令段。

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
  logo: "#d97706",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

function renderMsg(blocks: BlockMsg[]) {
  const msg: ChatMsg = { role: "assistant", blocks };
  useSessionStore.setState({ runtime: {}, commands: {} });
  // in_progress 块独立渲染不入组（折叠卡不展开）→ 直接可见展开态
  render(<MessageLine msg={msg} adapter={adapter} busy={false} isLast={false} />);
}

const toolBlock = (over: Partial<Extract<BlockMsg, { kind: "tool" }>>): BlockMsg => ({
  kind: "tool",
  toolCallId: "t1",
  title: "Terminal",
  status: "completed",
  content: [],
  ...over,
});

describe("P36 R1 终端两段式展开", () => {
  it("AC-1.1 execute 块命令段显示 command 全文（换行保留、不截断）", () => {
    renderMsg([
      toolBlock({
        status: "in_progress",
        toolKind: "execute",
        rawInput: { command: "echo a && echo b && c=$(ls)\ndo_something --very-long-flag" },
      }),
    ]);
    // 点开折叠卡
    fireEvent.click(screen.getByText("Terminal"));
    const cmd = screen.getByTestId("tool-command").querySelector("pre");
    expect(cmd?.textContent).toBe("echo a && echo b && c=$(ls)\ndo_something --very-long-flag");
  });

  it("AC-1.2 复制钮写剪贴板且不改变折叠态（stopPropagation）", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderMsg([
      toolBlock({ status: "in_progress", toolKind: "execute", rawInput: { command: "git status" } }),
    ]);
    fireEvent.click(screen.getByText("Terminal"));
    fireEvent.click(screen.getByRole("button", { name: "复制命令" }));
    expect(writeText).toHaveBeenCalledWith("git status");
    // 折叠态保持展开（命令段仍在）
    expect(screen.getByTestId("tool-command")).toBeTruthy();
  });

  it("AC-1.3a 无 text content 但 rawOutput 带 text → 兜底显示输出", () => {
    renderMsg([
      toolBlock({
        status: "in_progress",
        toolKind: "execute",
        rawInput: { command: "ls" },
        rawOutput: { content: [{ type: "text", text: "file1\nfile2" }], details: {} },
      }),
    ]);
    fireEvent.click(screen.getByText("Terminal"));
    expect(screen.getByTestId("tool-command")).toBeTruthy();
    expect(screen.getByText(/file1/)).toBeTruthy();
  });

  it("AC-1.3b 有 text content 时优先走 ToolTextView，rawOutput 不重复渲染", () => {
    renderMsg([
      toolBlock({
        status: "in_progress",
        toolKind: "execute",
        rawInput: { command: "ls" },
        rawOutput: { content: [{ type: "text", text: "fallback" }] },
        content: [{ kind: "text", text: "primary out" }],
      }),
    ]);
    fireEvent.click(screen.getByText("Terminal"));
    expect(screen.getByText("primary out")).toBeTruthy();
    expect(screen.queryByText("fallback")).toBeNull();
  });

  it("AC-1.6 read 类不渲染命令段", () => {
    renderMsg([
      toolBlock({
        status: "in_progress",
        toolKind: "read",
        rawInput: { file_path: "/a.ts" },
        content: [{ kind: "text", text: "file body" }],
      }),
    ]);
    fireEvent.click(screen.getByText("Terminal"));
    expect(screen.queryByTestId("tool-command")).toBeNull();
    expect(screen.getByText("file body")).toBeTruthy();
  });

  it("execute 无 command 字段（旧日志）→ 展开只有输出段，不渲染空命令块", () => {
    renderMsg([
      toolBlock({
        status: "in_progress",
        toolKind: "execute",
        content: [{ kind: "text", text: "out only" }],
      }),
    ]);
    fireEvent.click(screen.getByText("Terminal"));
    expect(screen.queryByTestId("tool-command")).toBeNull();
    expect(screen.getByText("out only")).toBeTruthy();
  });
});

// —— P36 R2：data-toolkind 差异化外观挂点 ——
describe("P36 R2 data-toolkind", () => {
  it("AC-2.1 根容器带 data-toolkind=协议 kind；旧日志缺省 → other", () => {
    renderMsg([
      toolBlock({ status: "in_progress", toolKind: "execute", rawInput: { command: "ls" } }),
    ]);
    expect(document.querySelector(".tool")?.getAttribute("data-toolkind")).toBe("execute");
    cleanup();

    renderMsg([toolBlock({ status: "in_progress", content: [{ kind: "text", text: "x" }] })]);
    expect(document.querySelector(".tool")?.getAttribute("data-toolkind")).toBe("other");
  });
});
