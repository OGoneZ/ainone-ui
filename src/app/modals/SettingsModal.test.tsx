// @vitest-environment jsdom
// SettingsModal 交互测试：adapter 列表加载、保存校验（id/program 非空）。
// P29 卡片化：预置卡片不再渲染 id/program 输入框（走名称/状态徽标 + 一键安装 +
// 配置模型），保存校验测试改用「新增 harness」的自定义行。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "./SettingsModal";
import { mockTauriIpc } from "@/test/mockIpc";

// F-8-7：快问配置走独立 Rust 命令，组件测试里 mock 掉（不依赖 Tauri 后端）
vi.mock("@/ipc/quickask", () => ({
  quickAskConfigGet: vi.fn().mockResolvedValue({
    base_url: "",
    model: "",
    timeout_ms: 30000,
    has_api_key: false,
    protocol: "openai",
    source: "",
  }),
  quickAskConfigSave: vi.fn().mockResolvedValue(undefined),
}));

// P29 S6：ModelSwitchPanel 依赖 sonner toast 与 logger（jsdom 无 Tauri 运行时）
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// ModelSwitchPanel 走 @/ipc/harnessMeta 的探测/写回（可编程 mock）
vi.mock("@/ipc/harnessMeta", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/ipc/harnessMeta")>();
  return {
    ...mod,
    probeModels: vi.fn(),
    writeHarnessSettings: vi.fn(),
  };
});

const ADAPTERS = [
  { id: "omp", name: "Oh My Pi", program: "omp", args: ["acp"], cwd: ".", logo: "#7c3aed" },
  { id: "codex", name: "Codex", program: "codex-acp", args: [], cwd: ".", logo: "#16a34a" },
];

function defaultHandlers() {
  return {
    adapters_list: () => ADAPTERS,
    adapter_status: () => ({ available: true, state: "ready", resolvedPath: "/usr/local/bin/omp", source: "ProcessPath", bridge: null, cli: null, auth: { state: "none", detail: "" } }),
    adapters_save: () => null,
    harness_config_read: () => ({ endpoint: "", hasApiKey: false, model: "", sourceFile: "/tmp/x", present: false }),
  };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("SettingsModal", () => {
  it("加载 adapter 列表并渲染名称", async () => {
    const calls = mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    // 名称渲染（P29 卡片化：预置行改为文本名称）
    expect(await screen.findByText("Oh My Pi")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    // 确实调了 adapters_list
    expect(calls.some((c) => c.cmd === "adapters_list")).toBe(true);
  });

  it("F-8-7 快问模型配置区渲染（P29 折叠进「更多服务」）", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    // 折叠区默认收起——展开后出现快问配置
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("more-toggle"));
    expect(screen.getByText("快问模型")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("https://api.openai.com/v1")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("gpt-4o-mini")).toBeInTheDocument();
  });

  it("P22 语音服务配置区渲染（P29 折叠进「更多服务」）", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId("more-toggle"));
    expect(screen.getByText("语音服务")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("https://asr.zhubaoduo.com/v1/audio/transcriptions")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("mano-asr")).toBeInTheDocument();
  });

  it("P22 快问来源徽标：auto:claude-code → 展示自动来源", async () => {
    const { quickAskConfigGet } = await import("@/ipc/quickask");
    vi.mocked(quickAskConfigGet).mockResolvedValueOnce({
      base_url: "https://gw.example.com",
      model: "saver/haiku",
      timeout_ms: 30000,
      has_api_key: true,
      protocol: "anthropic",
      source: "auto:claude-code",
    });
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId("more-toggle"));
    expect(await screen.findByText("自动：Claude Code")).toBeInTheDocument();
    // 接口地址占位随协议切换
    expect(screen.getByPlaceholderText("https://gw.example.com")).toBeInTheDocument();
  });

  it("P29 卡片化：预置卡片暴露状态徽标 + 配置模型，不暴露 id/program 输入框", async () => {
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    expect(await screen.findByTestId("adapter-card-omp")).toBeInTheDocument();
    expect(screen.getByTestId("status-omp")).toBeInTheDocument();
    expect(screen.getByTestId("cfg-toggle-omp")).toBeInTheDocument();
    // 预置卡片无 id/program 编辑框（防误改）
    expect(screen.queryByPlaceholderText("program")).not.toBeInTheDocument();
  });

  it("P29 保存校验：自定义行清空 id 后保存 → 提示错误，不调 adapters_save", async () => {
    const calls = mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    const user = userEvent.setup();
    // 新增自定义行（预置行无 id 输入框）
    await user.click(await screen.findByRole("button", { name: "新增 harness" }));
    const idInput = await screen.findByPlaceholderText("id");
    await user.clear(idInput);
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/id 与 program/)).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "adapters_save")).toBe(false);
  });

  it("保存成功 → 调 adapters_save 并回调 onSaved/onClose", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const calls = mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={onClose} onSaved={onSaved} theme="auto" onThemeChange={() => {}} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "保存" }));

    expect(calls.some((c) => c.cmd === "adapters_save")).toBe(true);
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("SettingsModal 外观分区（P26 R3 主题自工具栏迁入）", () => {
  it("渲染「外观」分区与主题下拉，切换时回调 onThemeChange", async () => {
    const onThemeChange = vi.fn();
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={onThemeChange} />);

    expect(await screen.findByText("外观")).toBeInTheDocument();
    const select = screen.getByDisplayValue("跟随系统") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    await userEvent.setup().selectOptions(select, "dark");
    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });
});

// —— P29：四态徽标 / 一键安装串联 / 配置模型表单 ——

// installCli / installBridge / refreshAdapterStatus 经 vi.mock 可编程（不在 mockIpc 里）
vi.mock("@/ipc/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/ipc/adapters")>();
  return {
    ...actual,
    installBridge: vi.fn().mockResolvedValue(undefined),
    installCli: vi.fn().mockResolvedValue(undefined),
    refreshAdapterStatus: vi.fn(async (a: any) => ({
      ...a,
      state: "ready",
      available: true,
      resolvedPath: "/usr/local/bin/omp",
      source: "ProcessPath",
      bridge: null,
      cli: null,
      auth: { state: "none", detail: "" },
    })),
  };
});

const OMP_CLI_INSTALLABLE = [
  { id: "omp", name: "Oh My Pi", program: "omp", args: ["acp"], cwd: ".", logo: "#7c3aed" },
];

function p29Handlers() {
  return {
    adapters_list: () => OMP_CLI_INSTALLABLE,
    // 探测结果：cli_installable（omp 已登记 CLI_INSTALLERS、bun/npm 在）
    adapter_status: () => ({
      available: false, state: "cli_installable", resolvedPath: null, source: null,
      bridge: null, cli: { display: "Oh My Pi", installable: true }, auth: { state: "none", detail: "" },
    }),
    adapters_save: () => null,
    harness_config_read: () => ({ endpoint: "https://old.example.com", hasApiKey: true, model: "old-model", sourceFile: "/home/x/.omp/agent/models.yml", present: true }),
  };
}

describe("P29 设置页卡片化", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // 默认探测结果：cli_installable（omp 已登记 CLI_INSTALLERS、bun/npm 在）
    const { refreshAdapterStatus } = await import("@/ipc/adapters");
    vi.mocked(refreshAdapterStatus).mockImplementation(async (a: any) => ({
      ...a,
      state: "cli_installable" as const,
      available: false,
      resolvedPath: null,
      source: null,
      bridge: null,
      cli: { display: "Oh My Pi", installable: true },
      auth: { state: "none", detail: "" },
    }));
  });
  afterEach(cleanup);

  it("四态徽标：cli_installable 显示「未安装 · 一键安装（CLI + 桥接器）」与「一键安装」按钮", async () => {
    mockTauriIpc({ handlers: p29Handlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    expect(await screen.findByTestId("status-omp")).toHaveTextContent(/未安装 · 一键安装/);
    const btn = screen.getByTestId("install-omp");
    expect(btn).toHaveTextContent("一键安装");
    expect(btn).not.toBeDisabled();
  });

  it("cli_installable 点一键安装 → installCli → refresh → refresh 后转 ready 不再装桥", async () => {
    mockTauriIpc({ handlers: p29Handlers() });
    const { installCli, refreshAdapterStatus } = await import("@/ipc/adapters");
    // 前一次调用 = 组件加载探测（beforeEach 默认 cli_installable）→ 渲染出「一键安装」按钮；
    // 本测试内重写 mock：点安装后的刷新改报 ready（CLI 装好了）
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    const btn = await screen.findByTestId("install-omp");

    vi.mocked(refreshAdapterStatus).mockImplementation(async (a: any) => ({
      ...a,
      state: "ready" as const, available: true, resolvedPath: "/x/omp", source: "home",
      bridge: null, cli: null, auth: { state: "none", detail: "" },
    }));
    const user = userEvent.setup();
    await user.click(btn);
    expect(installCli).toHaveBeenCalledWith("omp", expect.any(Function));
    await vi.waitFor(() => expect(screen.getByTestId("status-omp")).toHaveTextContent(/✓ 可用/));
  });

  it("配置模型：展开读取回显 → 保存调 harness_config_save → 显示已写入路径", async () => {
    const calls = mockTauriIpc({ handlers: p29Handlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId("cfg-toggle-omp"));
    // 读取回显
    await vi.waitFor(() => expect(screen.getByTestId("cfg-form-omp")).toBeInTheDocument());
    expect(await screen.findByDisplayValue("https://old.example.com")).toBeInTheDocument();
    expect(screen.getByDisplayValue("old-model")).toBeInTheDocument();
    // 修改模型后保存
    await user.clear(screen.getByDisplayValue("old-model"));
    await user.type(screen.getByPlaceholderText("model-id"), "new-model");
    await user.click(screen.getByTestId("cfg-save-omp"));
    await vi.waitFor(() => expect(screen.getByText(/已写入/)).toBeInTheDocument());
    const saveCall = calls.find((c) => c.cmd === "harness_config_save");
    expect(saveCall).toBeTruthy();
    expect(saveCall!.args.input.model).toBe("new-model");
  });

  it("P29 S6：配置模型表单有 endpoint 时出现「探测可用模型」入口，点击弹出 ModelSwitchPanel", async () => {
    const { probeModels, writeHarnessSettings } = await import("@/ipc/harnessMeta");
    vi.mocked(probeModels).mockResolvedValue(["m-a", "m-b"]);
    vi.mocked(writeHarnessSettings).mockResolvedValue({ path: "/p/settings.json", backup: "/p/settings.json.ainone-bak" });
    mockTauriIpc({ handlers: p29Handlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId("cfg-toggle-omp"));
    await vi.waitFor(() => expect(screen.getByTestId("cfg-probe-omp")).toBeInTheDocument());
    // 打开面板 → ModelSwitchPanel 打开即探测
    await user.click(screen.getByTestId("cfg-probe-omp"));
    await vi.waitFor(() => expect(probeModels).toHaveBeenCalledWith("omp", "https://old.example.com"));
    // 模型列表出现
    await vi.waitFor(() => expect(screen.getByText("m-b")).toBeInTheDocument());
  });
});

describe("Dialog 点遮罩关闭（P26 WKWebView mousedown 兜底）", () => {
  it("mousedown 落在 Content 外 → 合成 pointerdown 触发 Radix outside-close → onClose", async () => {
    const onClose = vi.fn();
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={onClose} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    await screen.findByText("外观");
    // 模拟 WKWebView 真实鼠标：只有 mousedown（无 pointerdown）落在 overlay（Content 外）
    const overlay = document.querySelector("[data-slot='dialog-overlay']");
    expect(overlay).not.toBeNull();
    const target = overlay as EventTarget;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "target", { value: target });
    document.dispatchEvent(down);
    // Radix Dialog deferPointerDownOutside=true：down 后等同一交互的 click 才 dismiss
    const up = new MouseEvent("mouseup", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "target", { value: target });
    document.dispatchEvent(up);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    Object.defineProperty(click, "target", { value: target });
    document.dispatchEvent(click);
    expect(onClose).toHaveBeenCalled();
  });
});
