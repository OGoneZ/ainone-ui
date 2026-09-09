// @vitest-environment jsdom
// P38 R4：建链加载悬浮层。
// 意图：建链全程（~1-2s）用户必须有明确反馈——悬浮层是「感知慢」的唯一出口：
//   1) 挂载即渲染场景文案（恢复会话「唤醒记忆」/ 新会话含 adapter 名）；
//   2) 分屏隔离：窗格内 absolute（CSS 锁），组件只负责内容与场景区分。
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BuildLoadingOverlay } from "@/chat/components/BuildLoadingOverlay";

afterEach(() => cleanup());

describe("P38：建链加载悬浮层", () => {
  it("恢复会话场景：主文案「正在唤醒这段对话的记忆」+ 回放副文案", () => {
    render(<BuildLoadingOverlay resume adapterName="Oh My Pi" />);
    const overlay = screen.getByTestId("build-overlay");
    expect(overlay.getAttribute("data-resume")).toBe("true");
    expect(screen.getByText("正在唤醒这段对话的记忆")).toBeInTheDocument();
    expect(screen.getByText(/回放历史消息/)).toBeInTheDocument();
  });

  it("新会话场景：主文案含 adapter 名 + 启动副文案（两段文案场景区分，规格定稿）", () => {
    render(<BuildLoadingOverlay resume={false} adapterName="Oh My Pi" />);
    const overlay = screen.getByTestId("build-overlay");
    expect(overlay.getAttribute("data-resume")).toBe("false");
    expect(screen.getByText("正在唤醒 Oh My Pi")).toBeInTheDocument();
    expect(screen.getByText(/启动 agent/)).toBeInTheDocument();
  });

  it("遮罩为 status role（aria-live）——建链完成自动消失前信息可达", () => {
    render(<BuildLoadingOverlay resume adapterName="x" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
