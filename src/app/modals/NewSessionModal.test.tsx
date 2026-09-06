// @vitest-environment jsdom
// NewSessionModal 测试（P25 cmdk 键盘化改写）：
// 两组列表渲染、↑↓ 导航高亮、Enter 选中 / 直接创建；
// 新建工作区流程（重复目录去重）保留。
// 键盘模拟用 fireEvent.keyDown 直发 cmdk root（userEvent 在 jsdom 下的
// 焦点模型与 cmdk 的 document 级监听不匹配，实测不触发导航）。
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

/** 向 cmdk root 派发 keydown（cmdk 在 root 的 onKeyDown 里处理导航）。
 *  Dialog 内容 portal 到 body，从 document 找 root。 */
function pressKey(_container: HTMLElement, key: string) {
  const root = document.querySelector("[cmdk-root]") as HTMLElement;
  fireEvent.keyDown(root, { key });
}

function selectedText(_container: HTMLElement): string {
  return (
    document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent ?? "(none)"
  );
}

describe("NewSessionModal（P25 cmdk）", () => {
  it("渲染 harness 组（含未安装禁用项）与工作区组（未归组 + 已有工作区）", () => {
    const { container } = renderModal();
    expect(screen.getByText("harness")).toBeInTheDocument();
    expect(screen.getByText("Oh My Pi")).toBeInTheDocument();
    expect(screen.getByText("Pi")).toBeInTheDocument(); // 未安装也渲染，disabled
    expect(screen.getByText(/未归组/)).toBeInTheDocument();
    expect(screen.getByText("dev")).toBeInTheDocument();
    // 首项默认高亮（textContent 含 ✓ 标记）
    expect(selectedText(container)).toContain("Oh My Pi");
  });

  it("↓ 跳过 disabled 项导航，Enter 选中工作区项", () => {
    const { container } = renderModal();
    // Oh My Pi → (Pi disabled 跳过) 未归组
    pressKey(container, "ArrowDown");
    expect(selectedText(container)).toBe("未归组（默认目录）");
    pressKey(container, "Enter");
    // 选中「未归组」后 workspaceId=null：✓ 移到未归组，dev 无 ✓
    const none = screen.getByText(/未归组/).closest("[cmdk-item]");
    expect(none?.querySelector(".ns-item-check")).toBeTruthy();
    const dev = screen.getByText("dev").closest("[cmdk-item]");
    expect(dev?.querySelector(".ns-item-check")).toBeFalsy();
  });

  it("点击工作区项选中；点「开始对话」按钮 → onConfirm 携带选中项", async () => {
    const onConfirm = vi.fn();
    renderModal(onConfirm);
    const user = userEvent.setup();
    await user.click(screen.getByText("dev"));
    // dev 项高亮（textContent 含 cwd 与 ✓ 标记）
    expect(document.querySelector('[cmdk-item][aria-selected="true"]')?.textContent).toContain("dev");
    // 点「开始对话」按钮（携带默认 harness omp + dev 工作区 cwd）
    await user.click(screen.getByTestId("ns-confirm-btn"));
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
  });

  it("键盘 ↑↓ 到「开始对话」项回车直接创建", () => {
    const onConfirm = vi.fn();
    const { container } = renderModal(onConfirm);
    // Oh My Pi → 未归组 → dev → 新建工作区 → 开始对话
    pressKey(container, "ArrowDown");
    pressKey(container, "ArrowDown");
    pressKey(container, "ArrowDown");
    pressKey(container, "ArrowDown");
    expect(selectedText(container)).toContain("开始对话");
    pressKey(container, "Enter");
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
  });

  it("选一个不存在的目录 → 新建工作区，选中之，回调 onWorkspaceCreated", async () => {
    const onCreated = vi.fn();
    pick.mockResolvedValue("/Users/me/new-project");
    render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        onClose={() => {}}
        onConfirm={vi.fn()}
        onWorkspaceCreated={onCreated}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByText(/新建工作区/));
    await user.click(screen.getByTestId("ns-confirm-btn"));

    // 新目录不重复 → 调 upsert
    expect(upsert).toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalled();
  });

  it("选一个已存在的目录 → 不新建工作区，直接选中既有", async () => {
    const onCreated = vi.fn();
    pick.mockResolvedValue("/Users/me/dev"); // 与 workspaces[0].cwd 相同
    render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        onClose={() => {}}
        onConfirm={vi.fn()}
        onWorkspaceCreated={onCreated}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByText(/新建工作区/));

    // 目录已存在 → 静默选中既有，不进 upsert
    expect(upsert).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("presetWorkspaceId 预填：对应工作区项带 ✓", () => {
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
    const dev = screen.getByText("dev").closest("[cmdk-item]");
    expect(dev?.querySelector(".ns-item-check")).toBeTruthy();
  });

  it("未安装 harness 项 disabled：点击不选中", async () => {
    renderModal();
    const user = userEvent.setup();
    await user.click(screen.getByText("Pi"));
    const pi = screen.getByText("Pi").closest("[cmdk-item]");
    expect(pi?.querySelector(".ns-item-check")).toBeFalsy();
  });
});
