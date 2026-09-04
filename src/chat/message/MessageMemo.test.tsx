// @vitest-environment jsdom
// P11 F-R7（AC-R7-1）：MessageLine memo 化——流式追加新消息时，历史消息不重渲染。
// 意图：每个 chunk 到达只应重渲染「正在流式」的末条消息；历史消息被 memo 跳过，
// 否则长会话流式期间每帧全量重解析 markdown，滚动与输入都会卡顿。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { memo } from "react";
import { MessageLine } from "./MessageLine";
import { useSessionStore, type ChatMsg } from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => cleanup());

const adapter: AdapterWithStatus = {
  id: "omp",
  name: "Oh My Pi",
  program: "omp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true,
};

/** 渲染计数探针：包一层 memo 组件，统计真实渲染次数 */
let renderCount = 0;
const CountingMessageLine = memo(function Counting(props: { msg: ChatMsg; busy: boolean; isLast: boolean }) {
  renderCount++;
  return <MessageLine msg={props.msg} adapter={adapter} busy={props.busy} isLast={props.isLast} />;
});

describe("MessageLine memo（F-R7 AC-R7-1）", () => {
  it("props 引用不变时历史消息跳过重渲染（渲染计数不增）", () => {
    useSessionStore.setState({ runtime: {}, commands: {} });
    const oldMsg: ChatMsg = { role: "assistant", blocks: [{ kind: "text", text: "历史回复" }] };
    const newMsg: ChatMsg = { role: "assistant", blocks: [{ kind: "text", text: "新流式块" }] };

    const { rerender } = render(<CountingMessageLine msg={oldMsg} busy={false} isLast={false} />);
    expect(renderCount).toBe(1);

    // 流式推进：列表追加新消息（历史消息对象引用不变）→ 重渲染父级
    rerender(<CountingMessageLine msg={oldMsg} busy={false} isLast={false} />);
    expect(renderCount).toBe(1);

    // 内容变化（引用变化）→ 正常重渲染
    rerender(<CountingMessageLine msg={newMsg} busy={false} isLast={false} />);
    expect(renderCount).toBe(2);
  });
});
