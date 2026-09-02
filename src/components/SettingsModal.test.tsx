// @vitest-environment jsdom
// SettingsModal 交互测试：adapter 列表加载、保存校验（id/program 非空）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsModal } from "./SettingsModal";
import { mockTauriIpc } from "../test/mockIpc";

const ADAPTERS = [
  { id: "omp", name: "Oh My Pi", program: "omp", args: ["acp"], cwd: ".", logo: "#7c3aed" },
  { id: "codex", name: "Codex", program: "codex-acp", args: [], cwd: ".", logo: "#16a34a" },
];

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe("SettingsModal", () => {
  it("加载 adapter 列表并渲染名称", async () => {
    const calls = mockTauriIpc({
      handlers: {
        adapters_list: () => ADAPTERS,
        adapter_available: () => true,
      },
    });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} />);

    // 名称渲染（输入框 value）
    expect(await screen.findByDisplayValue("Oh My Pi")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Codex")).toBeInTheDocument();
    // 确实调了 adapters_list
    expect(calls.some((c) => c.cmd === "adapters_list")).toBe(true);
  });

  it("保存校验：清空 id 后保存 → 提示错误，不调 adapters_save", async () => {
    const calls = mockTauriIpc({
      handlers: {
        adapters_list: () => ADAPTERS,
        adapter_available: () => true,
      },
    });
    render(<SettingsModal open={true} onClose={() => {}} onSaved={() => {}} />);

    const user = userEvent.setup();
    // 有多个 adapter 行，各有 id 输入框；取第一个
    const idInput = (await screen.findAllByPlaceholderText("id"))[0];
    await user.clear(idInput);
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText(/id 与 program/)).toBeInTheDocument();
    expect(calls.some((c) => c.cmd === "adapters_save")).toBe(false);
  });

  it("保存成功 → 调 adapters_save 并回调 onSaved/onClose", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const calls = mockTauriIpc({
      handlers: {
        adapters_list: () => ADAPTERS,
        adapter_available: () => true,
        adapters_save: () => null,
      },
    });
    render(<SettingsModal open={true} onClose={onClose} onSaved={onSaved} />);

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "保存" }));

    expect(calls.some((c) => c.cmd === "adapters_save")).toBe(true);
    expect(onSaved).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
