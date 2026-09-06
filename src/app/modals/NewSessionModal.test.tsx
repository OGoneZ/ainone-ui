// @vitest-environment jsdom
// NewSessionModal 测试（P26c 两步向导改写）：
// 每步列表只放业务选项（无「下一步/上一步/开始对话」操作项；第二步保留「新建工作区」）；
// 键盘：↑↓ 移高亮、第一步 →/Enter 进第二步、第二步 ← 回上一步、Enter 确认创建；
// 鼠标：点选项仅选中，推进/回退用底部按钮。
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

describe("NewSessionModal（P26c 两步向导）", () => {
  it("第一步：只有 harness 选项，无任何操作面板项", () => {
    renderModal();
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument();
    expect(screen.getByText("Oh My Pi")).toBeInTheDocument();
    expect(screen.getByText("Pi")).toBeInTheDocument();
    // P26c：操作面板已删
    expect(screen.queryByText("下一步 →")).not.toBeInTheDocument();
    expect(screen.queryByText(/未归组/)).not.toBeInTheDocument();
    expect(selectedText()).toContain("Oh My Pi");
    // 底部按钮：下一步 / 取消
    expect(screen.getByTestId("ns-next-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("ns-confirm-btn")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ns-back-btn")).not.toBeInTheDocument();
  });

  it("↑↓ 移动高亮（跳过 disabled），不推进步骤", () => {
    const { container } = renderModal();
    // Oh My Pi → (Pi disabled 跳过) 回到 Oh My Pi（只有两个项，loop）
    pressKey(container, "ArrowDown");
    expect(selectedText()).toContain("Oh My Pi");
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument(); // 仍在第一步
  });

  it("→ 键直接进第二步", () => {
    const { container } = renderModal();
    pressKey(container, "ArrowRight");
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
    expect(screen.getByText(/未归组/)).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
  });

  it("Enter 在第一步直接进第二步（高亮在 harness 项上）", async () => {
    const { container } = renderModal();
    pressKey(container, "Enter");
    await new Promise((r) => setTimeout(r, 10)); // 等 React 提交换步渲染
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
  });

  it("第二步：只有工作区选项 + 新建工作区，无上一步/开始对话面板项", async () => {
    const { container } = renderModal();
    pressKey(container, "ArrowRight"); // 进第二步
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByText("＋ 新建工作区（选目录）")).toBeInTheDocument();
    // P26c：操作面板已删（底部按钮保留「开始对话」，列表内无此项）
    expect(screen.queryByText(/上一步（重选 harness）/)).not.toBeInTheDocument();
    expect(container.querySelector('[data-value="ns-confirm"]')).toBeNull();
    // 底部按钮：上一步 / 开始对话 / 取消
    expect(screen.getByTestId("ns-back-btn")).toBeInTheDocument();
    expect(screen.getByTestId("ns-confirm-btn")).toBeInTheDocument();
  });

  it("第二步 ← 键回第一步", () => {
    const { container } = renderModal();
    pressKey(container, "ArrowRight"); // 进
    pressKey(container, "ArrowLeft"); // 回
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument();
  });

  it("第二步 ↑↓ 高亮即选中（✓ 跟随高亮），不推进步骤", async () => {
    const { container } = renderModal();
    pressKey(container, "ArrowRight"); // 进第二步，高亮=已选中的 dev
    await new Promise((r) => setTimeout(r, 10));
    expect(selectedText()).toContain("dev");
    // ↑ 到未归组 → ✓ 跟随（高亮即选中）
    pressKey(container, "ArrowUp");
    expect(selectedText()).toContain("未归组");
    const none = screen.getByText(/未归组/).closest("[cmdk-item]");
    expect(none?.querySelector(".ns-item-check")).toBeTruthy();
    const dev = screen.getByText("dev").closest("[cmdk-item]");
    expect(dev?.querySelector(".ns-item-check")).toBeFalsy();
    // 仍在第二步
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
  });

  it("第二步 Enter 直接确认创建（高亮在已选中的工作区项上）", async () => {
    const onConfirm = vi.fn();
    const { container } = renderModal(onConfirm);
    pressKey(container, "ArrowRight"); // 进第二步，高亮=dev（受控选中）
    await new Promise((r) => setTimeout(r, 10));
    pressKey(container, "Enter"); // 直接创建
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
  });

  it("第二步高亮在「新建工作区」时 Enter 不创建（交给 cmdk 走选目录）", async () => {
    const onConfirm = vi.fn();
    pick.mockResolvedValue("/Users/me/new-project");
    const { container } = renderModal(onConfirm);
    pressKey(container, "ArrowRight"); // 进第二步，高亮=dev
    await new Promise((r) => setTimeout(r, 10));
    pressKey(container, "ArrowDown"); // dev → 新建工作区
    expect(selectedText()).toContain("新建工作区");
    pressKey(container, "Enter");
    // 不创建会话，改走 pickDirectory
    await vi.waitFor(() => expect(pick).toHaveBeenCalled());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("鼠标：点 harness 项仅选中不推进；底部「下一步」按钮推进", async () => {
    renderModal();
    const user = userEvent.setup();
    await user.click(screen.getByText("Oh My Pi"));
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument(); // 不推进
    const omp = screen.getByText("Oh My Pi").closest("[cmdk-item]");
    expect(omp?.querySelector(".ns-item-check")).toBeTruthy();
    await user.click(screen.getByTestId("ns-next-btn"));
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument();
  });

  it("鼠标：第二步点工作区项仅选中；「上一步」按钮回退；「开始对话」创建", async () => {
    const onConfirm = vi.fn();
    const { container } = renderModal(onConfirm);
    pressKey(container, "ArrowRight"); // 进第二步
    const user = userEvent.setup();
    await user.click(screen.getByText("dev"));
    expect(screen.getByText(/选择工作目录/)).toBeInTheDocument(); // 不创建
    await user.click(screen.getByTestId("ns-back-btn"));
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument();
    // 再进第二步 → 开始对话
    await user.click(screen.getByTestId("ns-next-btn"));
    await user.click(screen.getByTestId("ns-confirm-btn"));
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
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

  it("第二步新建工作区：选不存在目录 → upsert + onWorkspaceCreated；确认创建携带新工作区", async () => {
    const onCreated = vi.fn();
    const onConfirm = vi.fn();
    pick.mockResolvedValue("/Users/me/new-project");
    render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={onConfirm}
        onWorkspaceCreated={onCreated}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText(/新建工作区/));
    await vi.waitFor(() => expect(upsert).toHaveBeenCalled());
    expect(onCreated).toHaveBeenCalled();
    await user.click(screen.getByTestId("ns-confirm-btn"));
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-new", "/Users/me/new-project");
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
