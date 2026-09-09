// @vitest-environment jsdom
// P36 R5 AC-3.3/5.1/5.2：ChatPanel open-file/ref-file 监听——事件归属判定
// （detail.tabKey === 自己 → 接收；别人的 → 忽略；旧 string detail → active 兜底）。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { ChatPanel } from "./ChatPanel";
import { useSessionStore } from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/ipc/adapters", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/ipc/adapters")>();
  return { ...mod };
});

const adapter: AdapterWithStatus = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

// 最小 ChatPanel 挂载：不开真会话（不发消息），只测事件监听行为
function mount(tabKey: string, active: boolean) {
  useSessionStore.setState({ runtime: {}, commands: {} });
  render(
    <ChatPanel
      tabKey={tabKey}
      adapter={adapter}
      cwd="/ws"
      active={active}
      visible
    />,
  );
}

function dispatch(detail: unknown) {
  window.dispatchEvent(new CustomEvent("ainone:open-file", { detail }));
}

async function expectPreview(path: string | null) {
  await waitFor(() => {
    const el = path ? screen.queryByTitle(`文件预览 ${path}`) || document.querySelector(".filepreview") : document.querySelector(".filepreview");
    if (path) expect(el).toBeTruthy();
    else expect(el).toBeNull();
  });
}

afterEach(cleanup);

describe("P36 R5 open-file 归属判定", () => {
  it("AC-3.3 detail.tabKey=自己 → 打开预览（即使非活跃窗格）", async () => {
    mount("tab-1", false);
    dispatch({ path: "/a/x.ts", tabKey: "tab-1" });
    await expectPreview("/a/x.ts");
  });

  it("AC-3.3 detail.tabKey=别人 → 忽略（不串扰）", async () => {
    mount("tab-1", true);
    dispatch({ path: "/a/x.ts", tabKey: "tab-2" });
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector(".filepreview")).toBeNull();
  });

  it("AC-5.2 旧 string detail：活跃窗格接收", async () => {
    mount("tab-1", true);
    dispatch("/a/legacy.ts");
    await expectPreview("/a/legacy.ts");
  });

  it("AC-5.2 旧 string detail：非活跃窗格忽略（与现状一致）", async () => {
    mount("tab-1", false);
    dispatch("/a/legacy.ts");
    await new Promise((r) => setTimeout(r, 30));
    expect(document.querySelector(".filepreview")).toBeNull();
  });
});
