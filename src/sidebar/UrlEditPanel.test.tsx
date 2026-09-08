// @vitest-environment jsdom
// P29 R6 UrlEditPanel 组件测试：
// URL 校验（非法拦截不发写回）、保存写回链路（writeHarnessSettings → onWritten → close）、
// 值未变时禁保存、保存失败 toast 且面板不关。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { UrlEditPanel, isValidHttpUrl } from "./UrlEditPanel";
import * as harnessMeta from "@/ipc/harnessMeta";

vi.mock("@/ipc/harnessMeta", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/ipc/harnessMeta")>();
  return { ...mod, writeHarnessSettings: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const writeHarnessSettings = vi.mocked(harnessMeta.writeHarnessSettings);

function setup(overrides: Partial<Parameters<typeof UrlEditPanel>[0]> = {}) {
  const props: Parameters<typeof UrlEditPanel>[0] = {
    open: true,
    onClose: vi.fn(),
    adapterId: "codex",
    adapterName: "Codex",
    baseUrl: "https://old.example.com/v1",
    onWritten: vi.fn(),
    ...overrides,
  };
  render(<UrlEditPanel {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
  writeHarnessSettings.mockResolvedValue({ path: "/h/.codex/config.toml", backup: "/h/.codex/config.toml.ainone-bak" });
});
afterEach(cleanup);

describe("isValidHttpUrl", () => {
  it("http/https 通过；空值/其他协议/非 URL 拒绝（AC-R6-3）", () => {
    expect(isValidHttpUrl("https://gw.example.com/v1")).toBe(true);
    expect(isValidHttpUrl("http://localhost:8080")).toBe(true);
    expect(isValidHttpUrl("")).toBe(false);
    expect(isValidHttpUrl("ftp://x")).toBe(false);
    expect(isValidHttpUrl("not a url")).toBe(false);
  });
});

describe("UrlEditPanel", () => {
  it("预填当前值；修改为合法新值后保存 → 写回 + onWritten + 关闭（AC-R6-1/2）", async () => {
    const props = setup();
    const input = screen.getByLabelText("接口地址") as HTMLInputElement;
    expect(input.value).toBe("https://old.example.com/v1");
    await userEvent.clear(input);
    await userEvent.type(input, "https://new.example.com/v1");
    await userEvent.click(screen.getByLabelText("保存接口地址"));
    await waitFor(() => expect(props.onWritten).toHaveBeenCalled());
    expect(writeHarnessSettings).toHaveBeenCalledWith("codex", { baseUrl: "https://new.example.com/v1" });
    expect(toast.success).toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it("非法 URL：拦截保存（保存钮禁用），不发写回命令（AC-R6-3）", async () => {
    setup();
    const input = screen.getByLabelText("接口地址");
    await userEvent.clear(input);
    await userEvent.type(input, "not a url");
    expect(screen.getByLabelText("保存接口地址")).toBeDisabled();
    expect(writeHarnessSettings).not.toHaveBeenCalled();
  });

  it("值未变化：保存禁用（避免无意义写回）", async () => {
    setup();
    expect(screen.getByLabelText("保存接口地址")).toBeDisabled();
    expect(writeHarnessSettings).not.toHaveBeenCalled();
  });

  it("写回失败：toast.error、onWritten 不调用、面板不关（错误路径）", async () => {
    writeHarnessSettings.mockRejectedValueOnce(new Error("磁盘只读"));
    const props = setup();
    const input = screen.getByLabelText("接口地址");
    await userEvent.clear(input);
    await userEvent.type(input, "https://new.example.com/v1");
    await userEvent.click(screen.getByLabelText("保存接口地址"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(props.onWritten).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
