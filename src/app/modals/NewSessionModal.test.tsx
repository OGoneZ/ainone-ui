// @vitest-environment jsdom
// NewSessionModal 测试（P26c 两步向导改写 + P28 三态/懒装门控）：
// 每步列表只放业务选项（无「下一步/上一步/开始对话」操作项；第二步保留「新建工作区」）；
// 键盘：↑↓ 移高亮、第一步 →/Enter 进第二步、第二步 ← 回上一步、Enter 确认创建；
// 鼠标：点选项仅选中，推进/回退用底部按钮。
// P28：absent 才 disabled；installable 可点，「开始对话」先装桥（进度尾迹回显、
// 成功后 onAdaptersRefresh 再 onConfirm；失败停留弹层展示错误）。
// 键盘模拟用 fireEvent.keyDown 直发 cmdk root（userEvent 在 jsdom 下的
// 焦点模型与 cmdk 的监听不匹配，实测不触发导航）。
// pickDirectory 被 mock，直接返回目录路径。installBridge 被 mock 成可编程 Promise。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewSessionModal } from "./NewSessionModal";
import type { AdapterWithStatus } from "@/ipc/adapters";
import type { Workspace } from "@/ipc/workspaces";
import * as wsMod from "@/ipc/workspaces";
import * as adaptersMod from "@/ipc/adapters";

vi.mock("@/ipc/workspaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ipc/workspaces")>();
  return {
    ...actual,
    pickDirectory: vi.fn(),
    workspacesUpsert: vi.fn(() => Promise.resolve("ws-new")),
  };
});

vi.mock("@/ipc/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ipc/adapters")>();
  return { ...actual, installBridge: vi.fn(), installCli: vi.fn() };
});

const pick = vi.mocked(wsMod.pickDirectory);
const upsert = vi.mocked(wsMod.workspacesUpsert);
const installBridge = vi.mocked(adaptersMod.installBridge);

const adapters: AdapterWithStatus[] = [
  { id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: null, available: true, state: "ready", resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" } },
  // P28：pi 走懒装桥语义——CLI 本体在、桥未装 → installable（可点、开始对话先装）
  { id: "pi", name: "Pi", program: "pi-acp", args: [], cwd: ".", logo: null, available: false, state: "installable", resolvedPath: null, source: null, bridge: { pkg: "pi-acp", version: "0.0.33", cliProgram: "pi", cliAvailable: true, runtimeAvailable: true }, cli: null, auth: { state: "none", detail: "" } },
  { id: "claude-code", name: "Claude Code", program: "claude-agent-acp", args: [], cwd: ".", logo: null, available: false, state: "absent", resolvedPath: null, source: null, bridge: { pkg: "@agentclientprotocol/claude-agent-acp", version: "0.73.0", cliProgram: "claude", cliAvailable: false, runtimeAvailable: true }, cli: null, auth: { state: "none", detail: "" } },
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
    renderModal();
    // P28：Pi 从 disabled 改为 installable（可点），↓ 应高亮到 Pi 而不是跳回
    pressKey(document.body, "ArrowDown");
    expect(selectedText()).toContain("Pi");
    expect(screen.getByText(/选择 Harness/)).toBeInTheDocument(); // 仍在第一步
  });

  it("P28 三态：installable 项可选中并显示自动安装注记，absent 项 disabled", () => {
    render(
      <NewSessionModal
        open={true}
        adapters={[
          ...adapters,
          { id: "codex", name: "Codex", program: "codex-acp", args: [], cwd: ".", logo: null, available: false, state: "absent", resolvedPath: null, source: null, bridge: { pkg: "@agentclientprotocol/codex-acp", version: "1.10.0", cliProgram: "codex", cliAvailable: false, runtimeAvailable: true }, cli: null, auth: { state: "none", detail: "" } },
        ]}
        workspaces={workspaces}
        onClose={() => {}}
        onConfirm={vi.fn()}
      />,
    );
    const pi = screen.getByText("Pi").closest("[cmdk-item]");
    expect(pi).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("未装 ACP 桥接器 · 首次使用自动安装")).toBeInTheDocument();
    const codex = screen.getByText("Codex").closest("[cmdk-item]");
    expect(codex).toHaveAttribute("aria-disabled", "true");
    expect(codex?.textContent).toContain("未安装");
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

  // —— P28 三态与懒装门控 ——

  it("P28：absent 行 disabled 标「未安装」；installable 行可点标「未装 ACP 桥接器」", () => {
    renderModal();
    const pi = screen.getByText("Pi").closest("[cmdk-item]");
    expect(pi?.getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getByText("未装 ACP 桥接器 · 首次使用自动安装")).toBeInTheDocument();
    const cc = screen.getByText("Claude Code").closest("[cmdk-item]");
    expect(cc?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("未安装")).toBeInTheDocument();
  });

  it("P28：installable 点「开始对话」→ 先装桥（进度回显），成功后刷新三态再建会话", async () => {
    let resolveInstall: () => void = () => {};
    installBridge.mockImplementation(
      (_program, onLine) =>
        new Promise<void>((res) => {
          resolveInstall = res;
          onLine?.("bun add v1.3.14");
          onLine?.("Resolving dependencies");
        }),
    );
    const onConfirm = vi.fn();
    const onRefresh = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={onConfirm}
        onAdaptersRefresh={onRefresh}
      />,
    );
    // 选 Pi（presetWorkspaceId 直落第二步 → 先回第一步换 harness）
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ns-back-btn"));
    await user.click(screen.getByText("Pi"));
    await user.click(screen.getByTestId("ns-next-btn"));
    await user.click(screen.getByTestId("ns-confirm-btn"));
    // 安装中：进度行 + 安装器输出尾迹回显，未建会话
    await waitFor(() => expect(installBridge).toHaveBeenCalledWith("pi-acp", expect.any(Function)));
    expect(screen.getByTestId("ns-install-progress")).toBeInTheDocument();
    // onLine 尾迹经 setInstallTail 异步入 DOM → waitFor
    await waitFor(() => expect(screen.getByText(/Resolving dependencies/)).toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
    // 装成 → 刷新三态 + 建会话
    resolveInstall();
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("pi", "ws-1", "/Users/me/dev"));
    expect(onRefresh).toHaveBeenCalled();
    void rerender;
  });

  it("P28：桥安装失败 → 不建会话，弹层停留展示错误", async () => {
    installBridge.mockRejectedValueOnce("连接器安装失败（网络）");
    const onConfirm = vi.fn();
    render(
      <NewSessionModal
        open={true}
        adapters={adapters}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={onConfirm}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ns-back-btn"));
    await user.click(screen.getByText("Pi"));
    await user.click(screen.getByTestId("ns-next-btn"));
    await user.click(screen.getByTestId("ns-confirm-btn"));
    await waitFor(() => expect(screen.getByTestId("ns-install-error")).toBeInTheDocument());
    expect(screen.getByText(/连接器安装失败/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // —— P29 四态：CLI 一键安装 + 两层解耦串联 ——

  const opencodeCliInstallable: AdapterWithStatus = {
    id: "opencode", name: "OpenCode", program: "opencode", args: [], cwd: ".", logo: null,
    available: false, state: "cli_installable", resolvedPath: null, source: null,
    bridge: null, cli: { display: "OpenCode", installable: true }, auth: { state: "none", detail: "" },
  };

  it("P29：cli_installable 项可选中并标「未安装 · 首次使用自动安装（CLI + 桥）」", () => {
    render(
      <NewSessionModal
        open={true}
        adapters={[adapters[0], opencodeCliInstallable]}
        workspaces={workspaces}
        onClose={() => {}}
        onConfirm={vi.fn()}
      />,
    );
    const oc = screen.getByText("OpenCode").closest("[cmdk-item]");
    expect(oc?.getAttribute("aria-disabled")).not.toBe("true");
    expect(screen.getByText(/未安装 · 首次使用自动安装（CLI \+ 桥）/)).toBeInTheDocument();
  });

  it("P29：cli_installable 点「开始对话」→ 先装 CLI（进度回显），成功后接装桥（fresh 状态驱动），全成建会话", async () => {
    const installCli = vi.mocked(adaptersMod.installCli);
    const callOrder: string[] = [];
    installCli.mockImplementation(async (_program, onLine) => {
      callOrder.push("cli");
      onLine?.("下载安装脚本 https://opencode.ai/install…");
    });
    installBridge.mockImplementation(async (_program, onLine) => {
      callOrder.push("bridge");
      onLine?.("bun add v1.3.14");
    });
    // 父级刷新：装完 CLI 后 props 换成 installable 的新状态（fresh 驱动第二段）
    const onConfirm = vi.fn();
    let currentAdapters = [adapters[0], opencodeCliInstallable];
    const onRefresh = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <NewSessionModal
        open={true}
        adapters={currentAdapters}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={onConfirm}
        onAdaptersRefresh={onRefresh}
      />,
    );
    // 模拟父级 onAdaptersRefresh 后 rerender 传新 props
    onRefresh.mockImplementation(() => {
      currentAdapters = [
        adapters[0],
        { ...opencodeCliInstallable, state: "installable" as const, bridge: { pkg: "opencode-acp", version: "0.1.0", cliProgram: "opencode", cliAvailable: true, runtimeAvailable: true } },
      ];
      rerender(
        <NewSessionModal
          open={true}
          adapters={currentAdapters}
          workspaces={workspaces}
          presetWorkspaceId="ws-1"
          onClose={() => {}}
          onConfirm={onConfirm}
          onAdaptersRefresh={onRefresh}
        />,
      );
      return Promise.resolve();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ns-back-btn"));
    await user.click(screen.getByText("OpenCode"));
    await user.click(screen.getByTestId("ns-next-btn"));
    // presetWorkspaceId 预填的是 ws-1；回第一步换 harness 后需重选工作区
    // （cmdk 受控 value 回调 ws-none 在 localWs 就绪前触发过一次，workspaceId 为 null）
    await user.click(screen.getByText("dev"));
    await user.click(screen.getByTestId("ns-confirm-btn"));
    // mock 立即 resolve，瞬态进度行无法稳定捕获——串联顺序以调用序为准
    await waitFor(() => expect(installCli).toHaveBeenCalledWith("opencode", expect.any(Function)));
    await waitFor(() => expect(installBridge).toHaveBeenCalled());
    expect(callOrder).toEqual(["cli", "bridge"]);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("opencode", "ws-1", "/Users/me/dev"));
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it("P29：CLI 装成功、桥装失败 → 错误展示「CLI 安装成功」语义区分，不建会话", async () => {
    const installCli = vi.mocked(adaptersMod.installCli);
    installCli.mockResolvedValue(undefined);
    installBridge.mockRejectedValueOnce("桥接器安装失败（网络）");
    const onConfirm = vi.fn();
    const onRefresh = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <NewSessionModal
        open={true}
        adapters={[adapters[0], opencodeCliInstallable]}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={onConfirm}
        onAdaptersRefresh={onRefresh}
      />,
    );
    onRefresh.mockImplementation(() => {
      rerender(
        <NewSessionModal
          open={true}
          adapters={[
            adapters[0],
            { ...opencodeCliInstallable, state: "installable" as const, bridge: { pkg: "opencode-acp", version: "0.1.0", cliProgram: "opencode", cliAvailable: true, runtimeAvailable: true } },
          ]}
          workspaces={workspaces}
          presetWorkspaceId="ws-1"
          onClose={() => {}}
          onConfirm={onConfirm}
          onAdaptersRefresh={onRefresh}
        />,
      );
      return Promise.resolve();
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ns-back-btn"));
    await user.click(screen.getByText("OpenCode"));
    await user.click(screen.getByTestId("ns-next-btn"));
    await user.click(screen.getByTestId("ns-confirm-btn"));
    await waitFor(() => expect(screen.getByTestId("ns-install-error")).toBeInTheDocument());
    expect(screen.getByText(/桥接器安装失败/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("P29：CLI 安装失败 → 错误标「CLI 安装失败」，不建会话不装桥", async () => {
    const installCli = vi.mocked(adaptersMod.installCli);
    installCli.mockRejectedValueOnce("退出状态 exit status: 1");
    const onConfirm = vi.fn();
    render(
      <NewSessionModal
        open={true}
        adapters={[adapters[0], opencodeCliInstallable]}
        workspaces={workspaces}
        presetWorkspaceId="ws-1"
        onClose={() => {}}
        onConfirm={onConfirm}
        onAdaptersRefresh={() => Promise.resolve()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("ns-back-btn"));
    await user.click(screen.getByText("OpenCode"));
    await user.click(screen.getByTestId("ns-next-btn"));
    await user.click(screen.getByTestId("ns-confirm-btn"));
    await waitFor(() => expect(screen.getByTestId("ns-install-error")).toBeInTheDocument());
    expect(screen.getByText(/CLI 安装失败/)).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
