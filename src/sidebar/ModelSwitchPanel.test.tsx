// @vitest-environment jsdom
// P29 R5 ModelSwitchPanel 组件测试：
// 打开即探测（loading→列表）、过滤、点选写回链路（set_config_option + writeHarnessSettings）、
// 探测失败可重试、无 baseUrl 不可探测、失败 toast。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ModelSwitchPanel } from "./ModelSwitchPanel";
import type { AcpSessionConfigOption } from "@/store/sessionStore";
import * as harnessMeta from "@/ipc/harnessMeta";

vi.mock("@/ipc/harnessMeta", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/ipc/harnessMeta")>();
  return {
    ...mod,
    probeModels: vi.fn(),
    writeHarnessSettings: vi.fn(),
  };
});
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
// logger 内部走 @tauri-apps/plugin-log（依赖 Tauri invoke），jsdom 无 Tauri 运行时 → mock 掉
vi.mock("@/lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const probeModels = vi.mocked(harnessMeta.probeModels);
const writeHarnessSettings = vi.mocked(harnessMeta.writeHarnessSettings);

const MODEL_OPTIONS = [
  { id: "model", name: "Model", category: "model", type: "select" as const, currentValue: "m-a", options: [] },
] as unknown as AcpSessionConfigOption[];

function setup(overrides: Partial<Parameters<typeof ModelSwitchPanel>[0]> = {}) {
  const props: Parameters<typeof ModelSwitchPanel>[0] = {
    open: true,
    onClose: vi.fn(),
    adapterId: "omp",
    adapterName: "Oh My Pi",
    baseUrl: "https://gw.example.com/v1",
    currentModel: "m-a",
    configOptions: MODEL_OPTIONS,
    onSessionModelChange: vi.fn().mockResolvedValue(undefined),
    onWritten: vi.fn(),
    ...overrides,
  };
  render(<ModelSwitchPanel {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  probeModels.mockResolvedValue(["m-a", "m-b", "m-c"]);
  writeHarnessSettings.mockResolvedValue({ path: "/p/settings.json", backup: "/p/settings.json.ainone-bak" });
});
afterEach(cleanup);

describe("ModelSwitchPanel", () => {
  it("打开即探测：loading 后展示网关返回的模型列表，当前模型高亮（AC-R5-2）", async () => {
    setup();
    expect(await screen.findByText("m-b")).toBeInTheDocument();
    expect(probeModels).toHaveBeenCalledWith("omp", "https://gw.example.com/v1");
    // 当前模型带「当前」tag（aria-selected）
    const cur = screen.getByRole("option", { name: /m-a/ });
    expect(cur).toHaveAttribute("aria-selected", "true");
  });

  it("探测失败：展示错误与重试按钮；重试成功后列表出现（AC-R5-2）", async () => {
    probeModels.mockRejectedValueOnce({ kind: "http", message: "HTTP 401" });
    setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 401");
    expect(screen.queryByText("m-b")).not.toBeInTheDocument();
    // 重试成功
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("m-b")).toBeInTheDocument();
  });

  it("无 baseUrl：不发起探测，显示不可探测提示（AC-R5-1 结构化降级）", async () => {
    setup({ baseUrl: null });
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(probeModels).not.toHaveBeenCalled();
  });

  it("过滤输入：列表实时收窄（AC-R5-2）", async () => {
    setup();
    await screen.findByText("m-b");
    await userEvent.type(screen.getByLabelText("过滤模型"), "b");
    expect(screen.getByText("m-b")).toBeInTheDocument();
    expect(screen.queryByText("m-a")).not.toBeInTheDocument();
  });

  it("点选模型：会话级 set_config_option + 配置写回 + onWritten + toast（AC-R5-6/7）", async () => {
    const props = setup();
    await screen.findByText("m-b");
    await userEvent.click(screen.getByRole("option", { name: /m-b/ }));
    expect(props.onSessionModelChange).toHaveBeenCalledWith("m-b");
    await waitFor(() => expect(props.onWritten).toHaveBeenCalled());
    expect(writeHarnessSettings).toHaveBeenCalledWith("omp", { model: "m-b" });
    expect(toast.success).toHaveBeenCalled();
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("写回失败：toast.error 且不关闭面板（AC-R5-2 错误路径）", async () => {
    writeHarnessSettings.mockRejectedValueOnce(new Error("磁盘只读"));
    const props = setup();
    await screen.findByText("m-b");
    await userEvent.click(screen.getByRole("option", { name: /m-b/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("不可写 harness（pi）但会话可切：仅会话级切换不写文件（AC-R5-5）", async () => {
    const props = setup({ adapterId: "pi", adapterName: "Pi" });
    await screen.findByText("m-b");
    await userEvent.click(screen.getByRole("option", { name: /m-b/ }));
    await waitFor(() => expect(props.onSessionModelChange).toHaveBeenCalledWith("m-b"));
    expect(writeHarnessSettings).not.toHaveBeenCalled();
    expect(props.onWritten).toHaveBeenCalled();
  });

  it("WebView 侧无 key 明文：probeModels/writeHarnessSettings 入参签名不含 key（AC-R5-7）", async () => {
    // 静态断言：IPC 封装签名只收 adapterId/baseUrl / patch——key 由 Rust 自取
    expect(probeModels).toBeDefined();
    setup();
    await screen.findByText("m-b");
    expect(probeModels).toHaveBeenCalledWith("omp", "https://gw.example.com/v1");
    expect(probeModels.mock.calls[0].length).toBe(2); // 无第三参（key 绝不经过前端）
  });
});
