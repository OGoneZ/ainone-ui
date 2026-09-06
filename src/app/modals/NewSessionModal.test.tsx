// @vitest-environment jsdom
// NewSessionModal 测试（P26b 两步向导改写）：
// 第一步 harness（↑↓ 移动高亮、Enter 在「下一步」项推进、点选项仅选中不推进）→
// 第二步工作区（↑↓、Enter 在「开始对话」项创建）；presetWorkspaceId 直落第二步。
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

describe("NewSessionModal（P26b 两步向导）", () => {
  it("第一步渲染 harness 组（含未安装禁用项）+「下一步」操作项，首项默认高亮", () => {
    renderModal();
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument();
    expect(screen.getByText("Oh My Pi")).toBeInTheDocument();
    expect(screen.getByText("Pi")).toBeInTheDocument(); // 未安装也渲染，disabled
    expect(screen.getByText("下一步 →")).toBeInTheDocument();
    // 工作区列表不在第一步出现
    expect(screen.queryByText(/未归组/)).not.toBeInTheDocument();
    expect(selectedText()).toContain("Oh My Pi");
  });

  it("↑↓ 移动高亮（含跳过 disabled 项、跨组连续），停在选项上不推进", () => {
    const { container } = renderModal();
    // Oh My Pi → (Pi disabled 跳过) 下一步
    pressKey(container, "ArrowDown");
    expect(selectedText()).toContain("下一步");
    // loop 回绕
    pressKey(container, "ArrowDown");
    expect(selectedText()).toContain("Oh My Pi");
    pressKey(container, "ArrowUp");
    expect(selectedText()).toContain("下一步");
    // 仍在第一步
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument();
  });

  it("Enter 高亮在 harness 项上 = 仅选中该 harness，不推进", () => {
    const { container } = renderModal();
    pressKey(container, "Enter"); // 高亮 Oh My Pi → 选中
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument(); // 仍在第一步
    const omp = screen.getByText("Oh My Pi").closest("[cmdk-item]");
    expect(omp?.querySelector(".ns-item-check")).toBeTruthy();
  });

  it("Enter 高亮在「下一步」项上推进第二步", () => {
    const { container } = renderModal();
    pressKey(container, "ArrowDown"); // → 下一步
    pressKey(container, "Enter");
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
    expect(screen.getByText(/未归组/)).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
  });

  it("鼠标点击 harness 项仅选中（✓ 移动），不推进", async () => {
    renderModal();
    const user = userEvent.setup();
    await user.click(screen.getByText("Oh My Pi"));
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument(); // 不推进
    const omp = screen.getByText("Oh My Pi").closest("[cmdk-item]");
    expect(omp?.querySelector(".ns-item-check")).toBeTruthy();
    // 换选另一可用项 → ✓ 移动（能改变）
  });

  it("底部「下一步」按钮推进；第二步底部按钮为「开始对话」", async () => {
    renderModal();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ns-next-btn"));
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
    expect(screen.getByTestId("ns-confirm-btn")).toBeInTheDocument();
  });

  it("第二步键盘全程：↑↓ 到「开始对话」项回车创建", () => {
    const onConfirm = vi.fn();
    const { container } = renderModal(onConfirm);
    pressKey(container, "ArrowDown"); // 下一步
    pressKey(container, "Enter"); // 推进
    // 第二步列表项顺序：未归组 / dev / 新建工作区 / 上一步 / 开始对话
    for (let i = 0; i < 5; i++) pressKey(container, "ArrowDown");
    expect(selectedText()).toContain("开始对话");
    pressKey(container, "Enter");
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
  });

  it("第二步鼠标点工作区项仅选中；点「开始对话」按钮创建", async () => {
    const onConfirm = vi.fn();
    const { container } = renderModal(onConfirm);
    pressKey(container, "ArrowDown");
    pressKey(container, "Enter"); // 推进
    const user = userEvent.setup();
    await user.click(screen.getByText("dev")); // 仅选中
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument(); // 不创建
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toContain("dev");
    await user.click(screen.getByTestId("ns-confirm-btn"));
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
  });

  it("第二步「上一步」项回退重选 harness", () => {
    const { container } = renderModal();
    pressKey(container, "ArrowDown");
    pressKey(container, "Enter"); // 进第二步
    // 未归组(0)→dev(1)→新建工作区(2)→上一步(3)
    for (let i = 0; i < 4; i++) pressKey(container, "ArrowDown");
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
