// @vitest-environment jsdom
// NewSessionModal 测试：工作区下拉、重复目录去重（选已存在目录不新建工作区）。
// pickDirectory 被 mock，直接返回目录路径。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewSessionModal } from "./NewSessionModal";
import type { AdapterWithStatus } from "../config/adapters";
import type { Workspace } from "../config/workspaces";
import * as wsMod from "../config/workspaces";

vi.mock("../config/workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/workspaces")>();
  return {
    ...actual,
    pickDirectory: vi.fn(),
    workspacesUpsert: vi.fn(() => Promise.resolve("ws-new")),
  };
});

const pick = vi.mocked(wsMod.pickDirectory);
const upsert = vi.mocked(wsMod.workspacesUpsert);

const adapters: AdapterWithStatus[] = [
  { id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: null, available: true },
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

describe("NewSessionModal", () => {
  it("渲染工作区下拉（未归组 + 已有工作区）", () => {
    renderModal();
    expect(screen.getByRole("option", { name: /未归组/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /dev/ })).toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: /新建工作区/ }));
    await user.click(screen.getByRole("button", { name: "开始对话" }));

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
    await user.click(screen.getByRole("button", { name: /新建工作区/ }));

    // 目录已存在 → 静默选中既有，不进 upsert
    expect(upsert).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("开始对话 → onConfirm 携带选中的 adapterId 与 workspaceId/cwd", async () => {
    const onConfirm = vi.fn();
    render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "开始对话" }));

    // 默认选中：harness 第一个（omp）+ 工作区第一个（ws-1）
    expect(onConfirm).toHaveBeenCalledWith("omp", "ws-1", "/Users/me/dev");
  });
});
