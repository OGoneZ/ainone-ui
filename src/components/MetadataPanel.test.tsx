// @vitest-environment jsdom
// MetadataPanel 元数据侧栏测试（F-8-4 AC-P8-19/20/21）：
// 折叠/展开持久化、字段展示、usage 进度条随 store 更新。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetadataPanel } from "./MetadataPanel";
import { useSessionStore } from "../store/sessionStore";
import type { AdapterWithStatus } from "../config/adapters";

const adapter: AdapterWithStatus = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: ["acp", "--model", "duo-king-6.6"],
  cwd: ".",
  logo: "#7c3aed",
  available: true,
};

beforeEach(() => {
  localStorage.clear();
  useSessionStore.setState({ runtime: {}, commands: {} });
});
afterEach(cleanup);

describe("MetadataPanel", () => {
  it("默认折叠：点击展开 → 显示字段（AC-P8-21）", async () => {
    render(
      <MetadataPanel tabKey="k1" adapter={adapter} sessionId="s-123" cwd="/a/b" />,
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
      <MetadataPanel tabKey="k1" adapter={adapter} sessionId="s" cwd="/x" />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("展开元数据侧栏"));
    expect(localStorage.getItem("ainone-metadata-open")).toBe("1");
  });

  it("注入 usage → 进度条与 token 展示（AC-P8-19/22 组件侧）", async () => {
    useSessionStore.getState().ensure("k1", "omp");
    useSessionStore.getState().setUsage("k1", { used: 500, size: 1000, cost: 1.25 });
    render(
      <MetadataPanel tabKey="k1" adapter={adapter} sessionId="s" cwd="/x" />,
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
});
