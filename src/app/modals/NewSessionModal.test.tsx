// @vitest-environment jsdom
// NewSessionModal 测试（P26 两步向导改写）：
// 第一步 harness（↑↓/Enter 推进）→ 第二步工作区（↑↓/Enter 创建）；
// presetWorkspaceId 直落第二步；新建工作区流程保留。
// 键盘模拟用 fireEvent.keyDown 直发 cmdk root（userEvent 在 jsdom 下的
// 焦点模型与 cmdk 的监听不匹配，实测不触发导航）。
// pickDirectory 被 mock，直接返回目录路径。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewSessionModal } from "./NewSessionModal";
import type { AdapterWithStatus } from "@/ipc/adapters";
import type { Workspace } from "@/ipc/workspaces";
import * as wsMod from "@/ipc/workspaces";

vi.mock("@/ipc/workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ipc/workspaces")>();
  return {
    ...actual,
    pickDirectory: vi.fn(),
    workspacesUpsert: vi.fn(() => Promise.resolve("ws-new")),
  };
});

const pick = vi.mocked(wsMod.pickDirectory);
const upsert = vi.mocked(wsMod.workspacesUpsert);

const adapters: AdapterWithStatus[] = [
  { id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: null, available: true, resolvedPath: null, source: null },
  { id: "pi", name: "Pi", program: "pi", args: [], cwd: ".", logo: null, available: false, resolvedPath: null, source: null },
];
const workspaces: Workspace[] = [
  { id: "ws-1", name: "dev", cwd: "/Users/me/dev", created_ms: 1 },
];

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

function renderModal(onConfirm = vi.fn()) {
  return render(
    <NewSessionModal
      open={true}
      adapters={adapters}
      workspaces={workspaces}
      onClose={() => {}}
      onConfirm={onConfirm}
    />,
  );
}

/** 向 cmdk root 派发 keydown（cmdk 在 root 的 onKeyDown 里处理导航；Dialog portal 到 body） */
function pressKey(_container: HTMLElement, key: string) {
  const root = document.querySelector("[cmdk-root]") as HTMLElement;
  fireEvent.keyDown(root, { key });
}

function selectedText(): string {
  return document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent ?? "(none)";
}

describe("NewSessionModal（P26 两步向导）", () => {
  it("第一步只渲染 harness 组（含未安装禁用项），首项默认高亮", () => {
    renderModal();
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument();
    expect(screen.getByText("harness（↑↓ 选择，Enter 下一步）")).toBeInTheDocument();
    expect(screen.getByText("Oh My Pi")).toBeInTheDocument();
    expect(screen.getByText("Pi")).toBeInTheDocument(); // 未安装也渲染，disabled
    // 工作区列表不在第一步出现
    expect(screen.queryByText(/未归组/)).not.toBeInTheDocument();
    // 首项默认高亮（textContent 含 ✓）
    expect(selectedText()).toContain("Oh My Pi");
    // 底部动作按钮为「下一步」
    expect(screen.getByTestId("ns-next-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("ns-confirm-btn")).not.toBeInTheDocument();
  });

  it("第一步 ↑↓ 跳过 disabled 项；Enter 选中并推进第二步", () => {
    const { container } = renderModal();
    // Oh My Pi → (Pi disabled 跳过) 高亮停在 Oh My Pi；Enter 推进
    pressKey(container, "ArrowDown");
    pressKey(container, "Enter");
    // 第二步：工作区组出现
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
    expect(screen.getByText("工作区（↑↓ 选择，Enter 确认）")).toBeInTheDocument();
    expect(screen.getByText(/未归组/)).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
    // 底部按钮切为「开始对话」
    expect(screen.getByTestId("ns-confirm-btn")).toBeInTheDocument();
  });

  it("点击 harness 项 = 选中并直接进第二步", async () => {
    renderModal();
    const user = userEvent.setup();
    await user.click(screen.getByText("Oh My Pi"));
    // 推进后第一步列表卸载
    expect(screen.queryByText("harness（↑↓ 选择，Enter 下一步）")).not.toBeInTheDocument();
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
  });

  it("第二步键盘导航到「开始对话」项回车直接创建（全程键盘）", () => {
    const onConfirm = vi.fn();
    const { container } = renderModal(onConfirm);
    // 第一步：Enter 选中首个 harness 并推进
    pressKey(container, "Enter");
    // 第二步列表项顺序：未归组 / dev / 新建工作区 / 上一步 / 开始对话
    for (let i = 0; i < 5; i++) pressKey(container, "ArrowDown");
    expect(selectedText()).toContain("开始对话");
    pressKey(container, "Enter");
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
  });

  it("第二步点「开始对话」按钮 → onConfirm 携带选中项", async () => {
    const onConfirm = vi.fn();
    const { container } = renderModal(onConfirm);
    pressKey(container, "Enter"); // 进第二步
    const user = userEvent.setup();
    await user.click(screen.getByText("dev")); // 鼠标选中 dev
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toContain("dev");
    await user.click(screen.getByTestId("ns-confirm-btn"));
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
  });

  it("第二步「上一步」项回退重选 harness", () => {
    const { container } = renderModal();
    pressKey(container, "Enter"); // 进第二步
    // 「上一步」是操作组第 2 项：未归组(0)→dev(1)→新建工作区(2)→上一步(3)
    for (let i = 0; i < 3; i++) pressKey(container, "ArrowDown");
    pressKey(container, "ArrowDown");
    expect(selectedText()).toContain("上一步");
    pressKey(container, "Enter");
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument();
  });

  it("presetWorkspaceId 预填：直落第二步且对应工作区带 ✓", () => {
    render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
    const dev = screen.getByText("dev").closest("[cmdk-item]");
    expect(dev?.querySelector(".ns-item-check")).toBeTruthy();
  });

  it("第二步新建工作区：选不存在的目录 → upsert + onWorkspaceCreated", async () => {
    const onCreated = vi.fn();
    pick.mockResolvedValue("/Users/me/new-project");
    render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={vi.fn()}
        onWorkspaceCreated={onCreated}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText(/新建工作区/));
    await user.click(screen.getByTestId("ns-confirm-btn"));
    expect(upsert).toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalled();
  });

  it("第二步新建工作区：选已存在目录 → 静默选中既有", async () => {
    const onCreated = vi.fn();
    pick.mockResolvedValue("/Users/me/dev"); // 与 workspaces[0].cwd 相同
    render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={vi.fn()}
        onWorkspaceCreated={onCreated}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText(/新建工作区/));
    expect(upsert).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
