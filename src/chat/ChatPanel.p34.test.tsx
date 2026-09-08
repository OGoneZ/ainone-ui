// @vitest-environment jsdom
// P34 R1：可见性/焦点语义切分防回归。
// 事故：R7 把虚拟列表 enabled 绑在「全局焦点」（active）上——分屏时失焦窗格
// 明明屏幕可见却被冻结 → getVirtualItems 空 → 消息区整块白屏（用户实测）。
// 修正：enabled 绑「屏幕可见性」（visible，per-tabset 选中），active 只管交互路由。
//
// 本文件用带 opts 透传的 useVirtualizer mock：记录最近一次 enabled 值，
// enabled=false 时 getVirtualItems 返回空（与 virtual-core 真实语义一致）——
// 锁定「可见→渲染、不可见→冻结、切回→恢复」三态。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ChatPanel } from "@/chat/ChatPanel";
import { useSessionStore } from "../store/sessionStore";
import { openSession } from "../acp/session";
import type { AdapterWithStatus } from "../ipc/adapters";

// —— useVirtualizer mock：透传 enabled 语义（真实 virtual-core 行为）——
const virtualizerState = { lastEnabled: true as boolean };
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (opts: { count: number; enabled?: boolean }) => {
    virtualizerState.lastEnabled = opts.enabled ?? true;
    const items =
      (opts.enabled ?? true)
        ? Array.from({ length: opts.count }, (_, index) => ({ key: index, index, start: 0 }))
        : [];
    return {
      getTotalSize: () => (opts.enabled ?? true) ? opts.count * 80 : 0,
      getVirtualItems: () => items,
      measureElement: () => {},
      scrollToIndex: vi.fn(),
    };
  },
}));

vi.mock("../acp/session", () => ({ openSession: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("../ipc/quickask", () => ({
  quickAskConfigGet: vi.fn().mockResolvedValue({
    base_url: "https://qa.example.com/v1", model: "m", timeout_ms: 30000, has_api_key: false,
  }),
  quickAsk: vi.fn().mockResolvedValue("解释"),
}));
vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockOpen = vi.mocked(openSession);

const adapter: AdapterWithStatus = {
  id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

/** 预置两条消息（虚拟列表有内容可渲染） */
function seedMessages() {
  useSessionStore.setState({
    runtime: {
      k1: {
        adapterId: "omp", sessionId: "s-1", busy: false, perm: null, prompted: true,
        usage: null, meta: null, configOptions: null, plan: null, ask: null, branch: null,
        capabilities: null, degraded: null,
        messages: [
          { role: "user", text: "第一条" },
          { role: "assistant", blocks: [{ kind: "text", text: "回复内容" }] },
        ],
      },
    },
    commands: {},
  } as never);
}

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ runtime: {}, commands: {} });
  seedMessages();
  mockOpen.mockReset();
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("P34 R1：可见性/焦点语义切分", () => {
  it("默认 visible=true（向后兼容）：虚拟列表 enabled 且消息渲染", () => {
    render(<ChatPanel tabKey="k1" adapter={adapter} />);
    expect(virtualizerState.lastEnabled).toBe(true);
    expect(screen.getByText("第一条")).toBeInTheDocument();
    expect(screen.getByText("回复内容")).toBeInTheDocument();
  });

  it("visible=false（分屏另一窗格被冻结？不——本用例锁定语义）：enabled=false，虚拟项不渲染", () => {
    render(<ChatPanel tabKey="k1" adapter={adapter} visible={false} />);
    expect(virtualizerState.lastEnabled).toBe(false);
    // 虚拟项卸载（virtual-core enabled=false → getVirtualItems 空）
    expect(screen.queryByText("回复内容")).not.toBeInTheDocument();
    // 但数据仍归 ChatPanel 所有（composer 等非虚拟区 UI 正常）——数据层永不卸载
    expect(screen.getByLabelText("消息输入")).toBeInTheDocument();
  });

  it("白屏回归锁定：分屏失焦窗格 = active=false 且 visible=true → 正常渲染", () => {
    // R7 事故场景：焦点在另一窗格（active=false），但本窗格屏幕可见（visible=true）。
    // 旧实现 enabled 跟 active 走 → 白屏；修正后 enabled 跟 visible 走 → 正常。
    render(<ChatPanel tabKey="k1" adapter={adapter} active={false} visible={true} />);
    expect(virtualizerState.lastEnabled).toBe(true);
    expect(screen.getByText("回复内容")).toBeInTheDocument();
  });

  it("冻结与恢复：visible 翻转 false→true，虚拟列表恢复渲染", () => {
    const { rerender } = render(<ChatPanel tabKey="k1" adapter={adapter} visible={false} />);
    expect(virtualizerState.lastEnabled).toBe(false);
    rerender(<ChatPanel tabKey="k1" adapter={adapter} visible={true} />);
    expect(virtualizerState.lastEnabled).toBe(true);
    expect(screen.getByText("回复内容")).toBeInTheDocument();
  });

  it("焦点语义不变：active=false 不影响 enabled（两信号正交）", () => {
    render(<ChatPanel tabKey="k1" adapter={adapter} active={false} />);
    expect(virtualizerState.lastEnabled).toBe(true);
  });
});
