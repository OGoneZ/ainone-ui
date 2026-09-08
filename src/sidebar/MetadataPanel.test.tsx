// @vitest-environment jsdom
// MetadataPanel 元数据侧栏测试（F-8-4 AC-P8-19/20/21）：
// 折叠/展开持久化、字段展示、usage 进度条随 store 更新。
// P31+：sessionModelChange 返回 boolean（连接器拒绝 → false，UI 才能如实提示）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetadataPanel } from "./MetadataPanel";
import { useSessionStore } from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";
import type { AcpSessionConfigOption } from "@/store/sessionStore";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), copy: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/ipc/harnessMeta", () => ({
  // fetchHarnessMeta 默认 null：模型展示走 args --model（duo-king-6.6），
  // 会话级用例里再 mock 成带 base_url 的静态配置以驱动探测。
  fetchHarnessMeta: vi.fn().mockResolvedValue(null),
  supportsWrite: vi.fn(() => true),
  probeModels: vi.fn().mockResolvedValue(["m-a", "m-b"]),
  writeHarnessSettings: vi.fn().mockResolvedValue({ path: "/p", backup: "/p.bak" }),
}));
vi.mock("@/ipc/adapters", () => ({}));

const adapter: AdapterWithStatus = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: ["acp", "--model", "duo-king-6.6"],
  cwd: ".",
  logo: "#7c3aed",
  available: true, state: true ? "ready" : "absent", resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSessionStore.setState({ runtime: {}, commands: {} });
});
afterEach(cleanup);

describe("MetadataPanel", () => {
  it("默认折叠：点击展开 → 显示字段（AC-P8-21）", async () => {
    render(
      <MetadataPanel tabKey="k1" adapter={adapter} sessionId="s-123" cwd="/a/b" session={null} />,
    );
    const user = userEvent.setup();

    // 初始折叠：只有展开按钮
    expect(screen.getByLabelText("展开元数据侧栏")).toBeInTheDocument();
    await user.click(screen.getByLabelText("展开元数据侧栏"));

    // 展开后字段可见
    expect(screen.getByText("s-123")).toBeInTheDocument();
    expect(screen.getByText("/a/b")).toBeInTheDocument();
    expect(screen.getByText("duo-king-6.6")).toBeInTheDocument();
    expect(screen.getByText("Oh My Pi")).toBeInTheDocument();
  });

  it("折叠状态持久化：展开后 localStorage 记 1（AC-P8-21）", async () => {
    render(
      <MetadataPanel tabKey="k1" adapter={adapter} sessionId="s" cwd="/x" session={null} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("展开元数据侧栏"));
    expect(localStorage.getItem("ainone-metadata-open")).toBe("1");
  });

  it("注入 usage → 进度条与 token 展示（AC-P8-19/22 组件侧）", async () => {
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.getState().setUsage("k1", { used: 500, size: 1000, cost: 1.25 });
    render(
      <MetadataPanel tabKey="k1" adapter={adapter} sessionId="s" cwd="/x" session={null} />,
    );

    const user = userEvent.setup();
    // 展开（默认折叠）
    if (screen.queryByLabelText("展开元数据侧栏")) {
      await user.click(screen.getByLabelText("展开元数据侧栏"));
    }

    expect(screen.getByText("500 / 1,000")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
    expect(screen.getByText(/≈ \$1\.25/)).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  // —— P31+：sessionModelChange 返回 boolean（连接器拒绝 → false） ——

  const MODEL_OPTION = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "m-a",
    options: [{ value: "m-a", name: "m-a" }],
  } as unknown as AcpSessionConfigOption;

  function sessionOf(setConfigOption: (configId: string, value: string) => Promise<unknown>) {
    return { setConfigOption };
  }

  it("setConfigOption 返回 null（连接器拒绝）→ ModelSwitchPanel 会话级失败路径走 toast.warning", async () => {
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.getState().setConfigOptions("k1", [MODEL_OPTION]);
    // 静态配置给 base_url（探测基准）；模型展示仍走 configOptions currentValue。
    // mock 的 supportsWrite 恒 true → omp 走「可写 + 会话拒绝」的 warning 分支。
    const { fetchHarnessMeta } = await import("@/ipc/harnessMeta");
    vi.mocked(fetchHarnessMeta).mockResolvedValue({ base_url: "https://gw.example.com/v1", model: null, api_key_present: true });
    const session = sessionOf(vi.fn().mockResolvedValue(null));
    render(
      <MetadataPanel tabKey="k1" adapter={adapter} sessionId="s" cwd="/x" session={session} />,
    );
    const user = userEvent.setup();
    if (screen.queryByLabelText("展开元数据侧栏")) {
      await user.click(screen.getByLabelText("展开元数据侧栏"));
    }
    // 打开模型面板（模型行 aria-label=切换模型）；等探测成功渲染列表
    await user.click(screen.getByRole("button", { name: "切换模型" }));
    const target = await screen.findByRole("option", { name: /m-b/ });
    // setConfigOption 被调（返回 null = 拒绝）→ 可写 harness 走 warning，不弹成功谎报
    const { toast } = await import("sonner");
    await user.click(target);
    await vi.waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    // 拒绝意味着会话内 currentValue 不变
    expect(useSessionStore.getState().runtime["k1"]?.configOptions?.[0].currentValue).toBe("m-a");
  });

  it("setConfigOption 返回 options（成功）→ store.setConfigOptions 写回", async () => {
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.getState().setConfigOptions("k1", [MODEL_OPTION]);
    const { fetchHarnessMeta } = await import("@/ipc/harnessMeta");
    vi.mocked(fetchHarnessMeta).mockResolvedValue({ base_url: "https://gw.example.com/v1", model: null, api_key_present: true });
    const nextOpts = [{ ...MODEL_OPTION, currentValue: "m-b" }];
    const session = sessionOf(vi.fn().mockResolvedValue(nextOpts));
    render(
      <MetadataPanel tabKey="k1" adapter={adapter} sessionId="s" cwd="/x" session={session} />,
    );
    const user = userEvent.setup();
    if (screen.queryByLabelText("展开元数据侧栏")) {
      await user.click(screen.getByLabelText("展开元数据侧栏"));
    }
    await user.click(screen.getByRole("button", { name: "切换模型" }));
    await screen.findByRole("option", { name: /m-b/ });
    await user.click(screen.getByRole("option", { name: /m-b/ }));
    await vi.waitFor(() =>
      expect(useSessionStore.getState().runtime["k1"]?.configOptions?.[0].currentValue).toBe("m-b"),
    );
  });
});
