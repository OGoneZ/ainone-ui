// @vitest-environment jsdom
// P25 ShortcutsModal 测试：渲染分组行数、录制改绑、冲突拒绝、恢复默认。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { ShortcutsModal } from "./ShortcutsModal";
import { useKeymapStore } from "@/store/keymapStore";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

beforeEach(() => {
  localStorage.clear();
  useKeymapStore.setState({ overrides: {} });
});
afterEach(cleanup);

function press(e: Partial<KeyboardEvent> & { key: string; code: string }) {
  document.dispatchEvent(new KeyboardEvent("keydown", { ...e, bubbles: true, cancelable: true } as KeyboardEventInit));
}

describe("ShortcutsModal", () => {
  it("渲染全部动作行（默认表 24 项）+ 三分组标题", () => {
    render(<ShortcutsModal open={true} onClose={() => {}} />);
    const rows = document.querySelectorAll(".shortcut-row");
    expect(rows.length).toBe(useKeymapStore.getState().defs.length);
    expect(screen.getByText("全局")).toBeInTheDocument();
    expect(screen.getByText("会话窗格")).toBeInTheDocument();
    expect(screen.getByText("会话（多击）")).toBeInTheDocument();
  });

  it("键位 chip 展示默认键位（Ctrl+B / Ctrl+K）", () => {
    render(<ShortcutsModal open={true} onClose={() => {}} />);
    const kbds = [...document.querySelectorAll(".shortcut-keys kbd")].map((k) => k.textContent);
    expect(kbds).toContain("Ctrl+B");
    expect(kbds).toContain("Ctrl+K");
    expect(kbds).toContain("Ctrl+N");
    expect(kbds).toContain("Ctrl+T");
  });

  it("录制改绑：点改绑 → 按新键 → 键位更新且标记「改」", async () => {
    render(<ShortcutsModal open={true} onClose={() => {}} />);
    // 找到「显示 / 隐藏左侧栏」行
    const row = [...document.querySelectorAll(".shortcut-row")].find((r) => r.textContent?.includes("左侧栏"))!;
    fireEvent.click(row.querySelector(".shortcut-rebind")!);
    expect(row.getAttribute("data-recording")).toBe("true");
    act(() => {
      press({ key: "i", code: "KeyI", ctrlKey: true });
    });
    // 录制结束，绑定更新
    expect(useKeymapStore.getState().overrides["app.toggle-sidebar"]).toEqual([{ code: "KeyI", ctrl: true, meta: false, shift: false, alt: false }]);
    expect(row.textContent).toContain("Ctrl+I");
    expect(row.querySelector(".shortcut-custom")).not.toBeNull();
  });

  it("录制中 Esc 取消（不改绑定）", () => {
    render(<ShortcutsModal open={true} onClose={() => {}} />);
    const row = [...document.querySelectorAll(".shortcut-row")].find((r) => r.textContent?.includes("左侧栏"))!;
    fireEvent.click(row.querySelector(".shortcut-rebind")!);
    act(() => {
      press({ key: "Escape", code: "Escape" });
    });
    expect(useKeymapStore.getState().overrides["app.toggle-sidebar"]).toBeUndefined();
    expect(row.getAttribute("data-recording")).toBeNull();
  });

  it("冲突拒绝：绑定到已被占用的键 → toast.error 且不写 store", async () => {
    const { toast } = await import("sonner");
    render(<ShortcutsModal open={true} onClose={() => {}} />);
    // 「显示 / 隐藏右侧栏」行绑到 Ctrl+B（已占用）→ 拒绝
    const row = [...document.querySelectorAll(".shortcut-row")].find((r) => r.textContent?.includes("右侧栏"))!;
    fireEvent.click(row.querySelector(".shortcut-rebind")!);
    act(() => {
      press({ key: "b", code: "KeyB", ctrlKey: true });
    });
    expect(toast.error).toHaveBeenCalled();
    expect(useKeymapStore.getState().overrides["app.toggle-rightrail"]).toBeUndefined();
    // 仍处于录制态（未成功）
    expect(row.getAttribute("data-recording")).toBe("true");
  });

  it("恢复默认：清空全部 overrides", async () => {
    useKeymapStore.getState().setBinding("app.toggle-sidebar", [{ code: "KeyI", ctrl: true }]);
    render(<ShortcutsModal open={true} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
    expect(useKeymapStore.getState().overrides).toEqual({});
  });

  it("改绑后快捷键真正生效（新键命中、旧键失效）", async () => {
    // 集成链路：ShortcutsModal 写 store → matchShortcut 用 overrides 判定
    const { matchShortcut } = await import("@/app/logic/keymap");
    render(<ShortcutsModal open={true} onClose={() => {}} />);
    const row = [...document.querySelectorAll(".shortcut-row")].find((r) => r.textContent?.includes("左侧栏"))!;
    fireEvent.click(row.querySelector(".shortcut-rebind")!);
    act(() => {
      press({ key: "i", code: "KeyI", ctrlKey: true });
    });
    const { DEFAULT_DEFS } = await import("@/app/logic/keymap");
    const overrides = useKeymapStore.getState().overrides;
    expect(matchShortcut({ code: "KeyI", ctrlKey: true }, DEFAULT_DEFS, "app.toggle-sidebar", overrides)).toBe(true);
    expect(matchShortcut({ code: "KeyB", ctrlKey: true }, DEFAULT_DEFS, "app.toggle-sidebar", overrides)).toBe(false);
  });
});

describe("P30 窗格内切 tab 快捷键进面板", () => {
  it("面板出现「窗格内下一个/上一个 tab」两行且可改绑（AC-R2-3）", async () => {
    const { matchShortcut, DEFAULT_DEFS } = await import("@/app/logic/keymap");
    render(<ShortcutsModal open={true} onClose={() => {}} />);
    const nextRow = [...document.querySelectorAll(".shortcut-row")].find((r) => r.textContent?.includes("窗格内下一个 tab"))!;
    const prevRow = [...document.querySelectorAll(".shortcut-row")].find((r) => r.textContent?.includes("窗格内上一个 tab"))!;
    expect(nextRow).toBeTruthy();
    expect(prevRow).toBeTruthy();
    // 改绑下一 tab 为 Ctrl+J → store 覆盖生效、旧键失效
    fireEvent.click(nextRow.querySelector(".shortcut-rebind")!);
    act(() => {
      press({ key: "j", code: "KeyJ", ctrlKey: true });
    });
    const overrides = useKeymapStore.getState().overrides;
    expect(matchShortcut({ code: "KeyJ", ctrlKey: true }, DEFAULT_DEFS, "pane.tab-next", overrides)).toBe(true);
    expect(matchShortcut({ code: "Tab", ctrlKey: true }, DEFAULT_DEFS, "pane.tab-next", overrides)).toBe(false);
  });
});
