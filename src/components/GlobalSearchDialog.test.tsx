// @vitest-environment jsdom
// GlobalSearchDialog（F-11-2）：Ctrl+F 弹层、fuzzy 过滤、选中回调。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { sessionsList } from "../config/sessions";
import { listAdapters } from "../config/adapters";
import type { SessionEntry } from "../config/sessions";

vi.mock("../config/sessions", () => ({
  sessionsList: vi.fn(),
}));
vi.mock("../config/adapters", () => ({
  listAdapters: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockList = vi.mocked(sessionsList);
const mockAdapters = vi.mocked(listAdapters);

const entries: SessionEntry[] = [
  { session_id: "s1", adapter_id: "omp", title: "修复登录页白屏", cwd: "/home/u/webapp", workspace_id: null, mtime_ms: 1000 },
  { session_id: "s2", adapter_id: "omp", title: "ACP session 回填", cwd: "/home/u/ainone-ui", workspace_id: null, mtime_ms: 2000 },
];

const adapter = {
  id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: "#7c3aed", available: true,
};

beforeEach(() => {
  localStorage.clear();
  mockList.mockReset().mockResolvedValue(entries);
  mockAdapters.mockReset().mockResolvedValue([adapter]);
});
afterEach(() => cleanup());

describe("GlobalSearchDialog（F-11-2）", () => {
  it("打开 → 列出最近会话（logo + 标题 + 时间）", async () => {
    const onPick = vi.fn();
    render(<GlobalSearchDialog open onOpenChange={vi.fn()} onPick={onPick} />);
    expect(await screen.findByText("修复登录页白屏")).toBeInTheDocument();
    expect(screen.getByText("ACP session 回填")).toBeInTheDocument();
    expect(screen.getByText("webapp")).toBeInTheDocument();
  });

  it("输入模糊关键词 → 过滤命中", async () => {
    render(<GlobalSearchDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />);
    const input = await screen.findByPlaceholderText(/搜索会话/);
    await userEvent.type(input, "白屏");
    expect(await screen.findByText("修复登录页白屏")).toBeInTheDocument();
    expect(screen.queryByText("ACP session 回填")).not.toBeInTheDocument();
  });

  it("点击命中 → onPick 收到该会话并关闭弹层", async () => {
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(<GlobalSearchDialog open onOpenChange={onOpenChange} onPick={onPick} />);
    const item = await screen.findByText("ACP session 回填");
    fireEvent.click(item);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].session_id).toBe("s2");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("无命中 → 显示「无匹配会话」", async () => {
    render(<GlobalSearchDialog open onOpenChange={vi.fn()} onPick={vi.fn()} />);
    const input = await screen.findByPlaceholderText(/搜索会话/);
    await userEvent.type(input, "zzzz");
    expect(await screen.findByText("无匹配会话")).toBeInTheDocument();
  });
});
