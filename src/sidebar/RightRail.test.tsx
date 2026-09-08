// @vitest-environment jsdom
// RightRail 终端模式测试（P30）：
// 终端 tab 有工作目录但无 harness 元数据/历史消息——右栏不再整体消失，
// 而是以「只有文件 tab」的形态存在：隐藏元数据/历史 tab，落点强制回 files；
// 折叠细栏杆同样只剩「文件」入口。防回归锚点：终端聚焦时文件树可用。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// switchTab/toggle 走 Tauri log 插件，jsdom 无运行时 → mock（同 HistoryPanel.test 先例）
vi.mock("@/lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/ipc/fslist", () => ({
  workspaceListDir: vi.fn(),
}));

import { RightRail } from "./RightRail";
import type { AdapterWithStatus } from "@/ipc/adapters";

import { workspaceListDir } from "@/ipc/fslist";
const mockList = vi.mocked(workspaceListDir);

const adapter: AdapterWithStatus = {
  id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: null,
  available: true, state: "ready", resolvedPath: null, source: null, bridge: null, cli: null,
  auth: { state: "none", detail: "" },
};

beforeEach(() => {
  mockList.mockReset();
  mockList.mockResolvedValue([{ name: "main.py", is_dir: false }]);
  localStorage.clear();
});
afterEach(cleanup);

function renderRail(props: Partial<Parameters<typeof RightRail>[0]> = {}) {
  return render(
    <RightRail
      tabKey="tab-1"
      adapter={adapter}
      sessionId={null}
      cwd="/Users/me/dev"
      session={null}
      open={true}
      tab="meta"
      onSwitchTab={() => {}}
      onToggle={() => {}}
      {...props}
    />,
  );
}

describe("RightRail terminalOnly（P30 终端 tab 文件树）", () => {
  it("终端模式：隐藏元数据/历史 tab，只显示文件 tab，落点 meta 强制回 files 渲染文件树", async () => {
    // 持久化 tab 停在 meta（普通会话最后所在 tab）→ 切到终端应直接落文件树，不白屏
    renderRail({ terminalOnly: true, tab: "meta" });

    expect(screen.queryByRole("tab", { name: "元数据" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "历史" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文件" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");

    // 文件树以 tab.cwd 为根正常加载（终端有工作目录 → 文件可查）
    expect(await screen.findByText("main.py")).toBeInTheDocument();
  });

  it("终端模式：折叠细栏杆只剩「文件」入口，点击展开回文件树", async () => {
    const onSwitchTab = vi.fn();
    renderRail({ terminalOnly: true, tab: "files", open: false, onSwitchTab });

    expect(screen.queryByText("元数据")).not.toBeInTheDocument();
    expect(screen.queryByText("历史")).not.toBeInTheDocument();
    expect(screen.getByText("文件")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByText("文件"));
    expect(onSwitchTab).toHaveBeenCalledWith("files");
  });

  it("非终端模式（回归守卫）：三 tab 齐全，meta 正常渲染，行为不变", () => {
    renderRail({ terminalOnly: false, tab: "meta" });

    expect(screen.getByRole("tab", { name: "元数据" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "文件" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "历史" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "元数据" })).toHaveAttribute("aria-selected", "true");
  });
});
