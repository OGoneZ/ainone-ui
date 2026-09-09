// @vitest-environment jsdom
// SettingsModal 交互测试：adapter 列表加载、保存校验（id/program 非空）。
// P29 卡片化：预置卡片不再渲染 id/program 输入框（走名称/状态徽标 + 一键安装 +
// 配置模型），保存校验测试改用「新增 harness」的自定义行。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

    // 折叠区默认收起——展开后出现快问配置（P32c：模型名改为探测入口按钮）
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("more-toggle"));
    expect(screen.getByText("快问模型")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("https://api.openai.com/v1")).toBeInTheDocument();
    expect(screen.getByTestId("qa-model-pick")).toBeInTheDocument();
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
    // 现代化下拉（radix DropdownMenu）：点开触发钮 → 选「深色模式」→ 回调 dark
    await userEvent.setup().click(screen.getByTestId("theme-select"));
    await userEvent.setup().click(await screen.findByTestId("theme-option-dark"));
    expect(onThemeChange).toHaveBeenCalledWith("dark");
  });

  it("WKWebView 无 pointerdown 时 mousedown 补丁可开下拉（防回归：radix Trigger 依赖 pointerdown 开局）", async () => {
    // 模拟 WKWebView：只派发 mousedown + mouseup + click，不发 pointerdown
    // （用户实测点不开的根因）。ThemeSelect trigger 的 mousedown 兜底会向自身
    // 补发合成 pointerdown → radix 照常 toggle 开菜单。
    const onThemeChange = vi.fn();
    mockTauriIpc({ handlers: defaultHandlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={onThemeChange} />);

    const { fireEvent } = await import("@testing-library/react");
    const trigger = await screen.findByTestId("theme-select");
    fireEvent.mouseDown(trigger);
    fireEvent.mouseUp(trigger);
    fireEvent.click(trigger);

    // 菜单项出现 = 补丁生效（radix 开局成功）；且未误触发 onThemeChange
    expect(await screen.findByTestId("theme-option-dark")).toBeInTheDocument();
    expect(onThemeChange).not.toHaveBeenCalled();
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

    // 探测异步：findByTestId 可能在「探测中…」占位时就命中 → 用 waitFor 等到四态徽标渲染
    await waitFor(() => expect(screen.getByTestId("status-omp")).toHaveTextContent(/未安装 · 一键安装/));
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
    // 模型名已改为探测入口按钮：显示回显模型
    expect(await screen.findByTestId("cfg-model-pick-omp")).toHaveTextContent("old-model");
    await user.click(screen.getByTestId("cfg-save-omp"));
    await vi.waitFor(() => expect(screen.getByText(/已写入/)).toBeInTheDocument());
    const saveCall = calls.find((c) => c.cmd === "harness_config_save");
    expect(saveCall).toBeTruthy();
    expect(saveCall!.args.input.model).toBe("old-model");
  });

  it("P29 S6：模型名探测入口——点击弹 ModelSwitchPanel，表单 endpoint+key 直传探测", async () => {
    const { probeModels, writeHarnessSettings } = await import("@/ipc/harnessMeta");
    vi.mocked(probeModels).mockResolvedValue(["m-a", "m-b"]);
    vi.mocked(writeHarnessSettings).mockResolvedValue({ path: "/p/settings.json", backup: "/p/settings.json.ainone-bak" });
    mockTauriIpc({ handlers: p29Handlers() });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId("cfg-toggle-omp"));
    await vi.waitFor(() => expect(screen.getByTestId("cfg-model-pick-omp")).toBeInTheDocument());
    // 旧的「探测可用模型」独立按钮已删除
    expect(screen.queryByTestId("cfg-probe-omp")).not.toBeInTheDocument();
    // 点击模型名入口 → ModelSwitchPanel 打开即探测
    await user.click(screen.getByTestId("cfg-model-pick-omp"));
    await vi.waitFor(() =>
      expect(probeModels).toHaveBeenCalledWith("omp", "https://old.example.com", undefined),
    );
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

// —— P30 权限模式开关（claude-code）：读回显 + 切换写 settings.json 单键 ——
// P36 起 read 返回布尔（true=bypass / false=auto / null=未配置），mock 同步更新。

const CLAUDE_ADAPTER = [
  { id: "claude-code", name: "Claude Code", program: "claude-agent-acp", args: [], cwd: ".", logo: "#d97706" },
];

function permHandlers(mode: unknown) {
  return {
    adapters_list: () => CLAUDE_ADAPTER,
    adapter_status: () => ({ available: true, state: "ready", resolvedPath: "/bin/claude-agent-acp", source: "Home", bridge: null, cli: null, auth: { state: "subscription", detail: "已登录订阅" } }),
    permission_mode_read: () => mode,
    permission_mode_save: (a: { mode: string }) => `/Users/x/.claude/settings.json (mode=${a.mode})`,
  };
}

describe("P30 权限模式开关", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("claude-code 卡片渲染开关；settings 已是 auto → 开关为关", async () => {
    mockTauriIpc({ handlers: permHandlers(false) });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    const sw = await screen.findByTestId("perm-switch-claude-code");
    expect(sw).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByText(/defaultMode=auto/)).toBeInTheDocument();
  });

  it("未配置 defaultMode（null）→ 开关默认为开（bypass）", async () => {
    mockTauriIpc({ handlers: permHandlers(null) });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    const sw = await screen.findByTestId("perm-switch-claude-code");
    expect(sw).toHaveAttribute("data-state", "checked");
  });

  it("切换开 → permission_mode_save(bypassPermissions)；切回关 → save(auto)", async () => {
    const calls = mockTauriIpc({ handlers: permHandlers(false) });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    const sw = await screen.findByTestId("perm-switch-claude-code");
    expect(sw).toHaveAttribute("data-state", "unchecked");
    // 关 → 开：写 bypassPermissions
    await userEvent.setup().click(sw);
    expect(calls.find((c) => c.cmd === "permission_mode_save")?.args.mode).toBe("bypassPermissions");
    expect(await screen.findByText(/已写入/)).toBeInTheDocument();
    // 开 → 关：写回 auto
    await userEvent.setup().click(screen.getByTestId("perm-switch-claude-code"));
    const saves = calls.filter((c) => c.cmd === "permission_mode_save");
    expect(saves).toHaveLength(2);
    expect(saves[1].args.mode).toBe("auto");
  });

  it("P36 后 omp/codex 也渲染开关（读失败 reject → 禁用态而非隐藏）", async () => {
    mockTauriIpc({
      handlers: {
        ...defaultHandlers(),
        // P36 Rust 侧四家 read 均返回 Some(bool)；null/reject 只在读取异常时出现
        permission_mode_read: () => Promise.reject("读取失败"),
      },
    });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    await screen.findByText("Oh My Pi");
    await screen.findByText("Codex");
    // 读失败 → 开关仍渲染但禁用（disabled 属性），不是隐藏
    const omp = await screen.findByTestId("perm-switch-omp");
    expect(omp).toHaveAttribute("data-disabled");
    expect(await screen.findByTestId("perm-switch-codex")).toHaveAttribute("data-disabled");
  });
});

// —— P36 权限开关扩展到四家（omp/codex/opencode 开关 + pi 不支持态）——
// 回归目标：P30 只渲染 claude-code 的现状是错的——四家都有原生权限机制；
// pi 是唯一无机制的（README「No permission popups」），如实呈现不支持而非隐藏。

const FOUR_ADAPTERS = [
  { id: "omp", name: "Oh My Pi", program: "omp", args: ["acp"], cwd: ".", logo: "#7c3aed" },
  { id: "claude-code", name: "Claude Code", program: "claude-agent-acp", args: [], cwd: ".", logo: "#d97706" },
  { id: "codex", name: "Codex", program: "codex-acp", args: [], cwd: ".", logo: "#16a34a" },
  { id: "opencode", name: "OpenCode", program: "opencode", args: ["acp"], cwd: ".", logo: "#dc2626" },
  { id: "pi", name: "Pi", program: "pi-acp", args: [], cwd: ".", logo: "#2563eb" },
];

function perm4Handlers(returns: Record<string, unknown>) {
  return {
    adapters_list: () => FOUR_ADAPTERS,
    adapter_status: () => ({ available: true, state: "ready", resolvedPath: "/bin/x", source: "Home", bridge: null, cli: null, auth: { state: "none", detail: "" } }),
    permission_mode_read: (a: { adapterId: string }) => {
      // pi：Rust 侧 Err（无权限机制）→ reject 触发不支持态
      if (a.adapterId === "pi") return Promise.reject("pi 无权限确认机制");
      return returns[a.adapterId] ?? null;
    },
    permission_mode_save: (a: { adapterId: string; mode: string }) => `/fake/${a.adapterId} (mode=${a.mode})`,
  };
}

describe("P36 权限开关四家扩展", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("omp/codex/opencode 渲染开关（含各家文案）；pi 渲染不支持说明而非开关", async () => {
    mockTauriIpc({
      handlers: perm4Handlers({ omp: true, "claude-code": null, codex: false, opencode: null, pi: null }),
    });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    // omp：读到 true → 开（yolo 文案）
    const omp = await screen.findByTestId("perm-switch-omp");
    expect(omp).toHaveAttribute("data-state", "checked");
    expect(screen.getByText(/approvalMode=yolo/)).toBeInTheDocument();
    // codex：读到 false → 关（默认审批模式文案）
    const codex = await screen.findByTestId("perm-switch-codex");
    expect(codex).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByText(/默认审批模式/)).toBeInTheDocument();
    // opencode：未配置(null) → 开（默认放行）
    const oc = await screen.findByTestId("perm-switch-opencode");
    expect(oc).toHaveAttribute("data-state", "checked");
    // pi：不支持态文案，无开关
    expect(screen.queryByTestId("perm-switch-pi")).not.toBeInTheDocument();
    expect(await screen.findByText(/Pi 无权限确认机制/)).toBeInTheDocument();
  });

  it("omp 切换 → save(bypassPermissions|auto) 语义保留（Rust 侧映射 yolo/always-ask）", async () => {
    const calls = mockTauriIpc({
      handlers: perm4Handlers({ omp: false }),
    });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    const omp = await screen.findByTestId("perm-switch-omp");
    expect(omp).toHaveAttribute("data-state", "unchecked");
    await userEvent.setup().click(omp);
    expect(calls.find((c) => c.cmd === "permission_mode_save")?.args.adapterId).toBe("omp");
    expect(calls.find((c) => c.cmd === "permission_mode_save")?.args.mode).toBe("bypassPermissions");
    expect(await screen.findByText(/已写入/)).toBeInTheDocument();
  });

  it("codex 切换写 app 托管键（对新会话生效文案）", async () => {
    const calls = mockTauriIpc({
      handlers: perm4Handlers({ codex: false }),
    });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} theme="auto" onThemeChange={() => {}} />);
    const codex = await screen.findByTestId("perm-switch-codex");
    await userEvent.setup().click(codex);
    expect(calls.find((c) => c.cmd === "permission_mode_save")?.args.adapterId).toBe("codex");
    expect(await screen.findByText(/已写入/)).toBeInTheDocument();
  });
});

// —— P30 开关层叠回归（实测缺陷防回归，勿删）——
// app.css 的 `.adapter-row button` 等容器重置规则是 unlayered，恒胜 Tailwind
// @layer utilities 的颜色类（data-[state]:bg-primary 等）。曾把开关轨道刷成
// 弹窗白底、白色滑块白上白不可见（用户实测「怎么滑都是白」）。修复 = 外观改由
// app.css unlayered 的 button[role=switch] 规则块驱动。本组测试在产物层断言：
// ① switch 外观规则存在且在容器重置之后；② 容器重置不再命中 role=switch；
// ③ 组件不再依赖 utilities 颜色类（类名层面回归封锁）。
describe("P30 开关层叠回归（unlayered 容器重置 vs utilities 颜色类）", () => {
  /** 读仓库源文件（tsconfig 未含 @types/node → 动态 import + 字符串路径规避类型检查，同 layout.test.ts 惯例） */
  async function readSrc(path: string): Promise<string> {
    const mod: { readFileSync: (p: string, enc: string) => string } = await import(/* @vite-ignore */ "nod" + "e:fs");
    return mod.readFileSync(path, "utf-8");
  }

  const appCss = () => readSrc("src/app/app.css");

  it("app.css 含 unlayered 的 button[role=switch] 外观规则（checked 蓝轨 + thumb 位移）", async () => {
    const css = await appCss();
    expect(css).toMatch(/button\[role="switch"\]\s*\{/); // 基础轨道
    expect(css).toMatch(/button\[role="switch"\]\[data-state="checked"\]\s*\{/); // 开态
    expect(css).toMatch(/button\[role="switch"\]\[data-state="checked"\]\s*>\s*\[data-slot="switch-thumb"\]/); // 滑块位移
    // 开态轨道必须用品牌蓝（--primary），不是透明/白
    const checkedBlock = css.match(/button\[role="switch"\]\[data-state="checked"\]\s*\{[^}]*\}/)![0];
    expect(checkedBlock).toContain("var(--primary)");
  });

  it("容器按钮重置不再命中开关：role=switch 例外已从 .adapter-row button 移除", async () => {
    const css = await appCss();
    // 基础重置规则块内不得出现 role="switch"（旧 transparent 例外方向错误，已删）
    const baseReset = css.match(/\.adapter-row button,\s*\.ns-new-ws\s*\{[^}]*\}/)![0];
    expect(baseReset).not.toContain("switch");
    // unlayered switch 规则必须在容器重置之后出现（同层后到者胜）
    const resetIdx = css.indexOf(baseReset);
    const switchIdx = css.search(/button\[role="switch"\]\s*\{/);
    expect(switchIdx).toBeGreaterThan(resetIdx);
  });

  it("Switch 组件不再携带 utilities 颜色类（外观全权由 app.css 驱动）", async () => {
    const src = await readSrc("src/components/ui/switch.tsx");
    // 只断言 className 实参（剥掉注释——注释里记载着教训文本，含这些词）
    const classNames = src.match(/cn\(([^)]*)\)/g) ?? [];
    const joined = classNames.join("\n");
    expect(joined).not.toMatch(/bg-primary|bg-input|bg-background/); // 颜色类回归封锁
    expect(joined).not.toMatch(/translate-x-5|h-6|w-11/); // 尺寸/位移类同样不在组件层
    expect(src).toContain("data-slot=\"switch-thumb\""); // thumb 结构保留（app.css 依赖此选择器）
  });
});
