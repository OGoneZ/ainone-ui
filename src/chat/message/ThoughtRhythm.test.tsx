// @vitest-environment jsdom
// P32 AC-1.x：思考块展开节奏——live 判定与渲染位置解耦 + sealed 自动折叠 + 用户操作不被翻转。
// 意图（WHY）：流式中思考块闪收（thought 后跟 tool 即被误判非 live）是画面抖动的来源之一；
// live 只应看数据（ms 是否落定 + 是否流式 turn），用户手动操作永远优先于自动行为。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MessageLine } from "./MessageLine";
import { useSessionStore, type ChatMsg } from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";
import type { BlockMsg } from "@/acp/message-log";

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => cleanup());

const adapter: AdapterWithStatus = {
  id: "claude-code",
  name: "Claude Code",
  program: "claude-agent-acp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
};

const thought = (text: string, ms?: number): BlockMsg => ({
  kind: "thought",
  text,
  ...(ms !== undefined ? { ms } : {}),
});
const tool = (over: Partial<Extract<BlockMsg, { kind: "tool" }>>): BlockMsg => ({
  kind: "tool",
  toolCallId: "t1",
  title: "Terminal",
  status: "in_progress",
  content: [],
  ...over,
});

function renderMsg(blocks: BlockMsg[], streaming: boolean) {
  const msg: ChatMsg = { role: "assistant", blocks };
  useSessionStore.setState({ runtime: {}, commands: {} });
  return render(
    <MessageLine msg={msg} index={0} adapter={adapter} busy={streaming} isLast={streaming} />,
  );
}

/** 流式时序模拟：rerender 换 blocks，保持 busy && isLast */
function rerenderMsg(view: ReturnType<typeof render>, blocks: BlockMsg[], streaming = true) {
  const msg: ChatMsg = { role: "assistant", blocks };
  view.rerender(<MessageLine msg={msg} index={0} adapter={adapter} busy={streaming} isLast={streaming} />);
}

describe("思考块 live 判定与渲染位置解耦（P32 AC-1.1/1.3）", () => {
  it("AC-1.1：流式 turn 中 ms 未落 → 展开渲染正文", () => {
    renderMsg([thought("正在推理…")], true);
    expect(screen.getByText("正在推理…")).toBeTruthy();
  });

  it("AC-1.3：thought 后跟 tool（thought 已非最后一个渲染项）→ 只要 ms 未落仍保持展开", () => {
    // 对照现状回归：旧实现 live 只给最后一个渲染项，thought 一接 tool 就闪收。
    // streaming 分组把尾部 groupable 段全部独立渲染，此时组卡摘要不可见
    const view = renderMsg([thought("第一段思考")], true);
    expect(screen.getByText("第一段思考")).toBeTruthy();
    rerenderMsg(view, [thought("第一段思考"), tool({ toolCallId: "t1", status: "in_progress" })]);
    expect(screen.getByText("第一段思考")).toBeTruthy();
  });

  it("新思考段（第一段已 seal）开流 → 回到展开；sealed 段在流式中仍可见（独立渲染）", () => {
    // 两个独立思考段：第一段 ms 已落（流式中独立渲染、不自动展开），第二段流式中展开
    renderMsg([thought("第一段", 1500), tool({ toolCallId: "t1", status: "completed", ms: 100 }), thought("第二段思考")], true);
    expect(screen.queryByText("第一段")).toBeNull(); // sealed 折叠行不可见正文
    expect(screen.getByText("第二段思考")).toBeTruthy(); // 流式中展开
  });
});

describe("sealed 自动折叠（P32 AC-1.2/1.6）", () => {
  it("AC-1.2：ms 落定（live true→false）→ 自动折叠为「已思考 N 秒」行（turn 结束收组可见）", async () => {
    const view = renderMsg([thought("思考中内容")], true);
    expect(screen.getByText("思考中内容")).toBeTruthy();
    // seal 后 turn 结束（busy=false）→ 收进组卡；展开组卡可见「已思考 2 秒」
    rerenderMsg(view, [thought("思考中内容", 2000)], false);
    fireEvent.click(screen.getByText(/思考 1 次/));
    expect(screen.getByText(/已思考 2 秒/)).toBeTruthy();
    expect(screen.queryByText("思考中内容")).toBeNull(); // 正文折叠
  });

  it("AC-1.6：历史/静态消息 thought 恒折叠（入组卡，展开可见摘要行）", () => {
    renderMsg([thought("历史思考", 3000)], false);
    expect(screen.queryByText("历史思考")).toBeNull();
    fireEvent.click(screen.getByText(/思考 1 次/));
    expect(screen.getByText(/已思考 3 秒/)).toBeTruthy();
  });
});

describe("用户操作不被自动翻转（P32 AC-1.4）", () => {
  it("AC-1.4：流式中用户手动收起 → 同一思考段继续流式不再自动展开", () => {
    const view = renderMsg([thought("流式思考")], true);
    expect(screen.getByText("流式思考")).toBeTruthy();
    // 手动收起（点击头部行）
    fireEvent.click(screen.getByText(/思考中/));
    expect(screen.queryByText("流式思考")).toBeNull();
    // 继续流式（chunk 追加，仍无 ms）
    rerenderMsg(view, [thought("流式思考更多内容")]);
    expect(screen.queryByText("流式思考更多内容")).toBeNull();
  });

  it("用户手动展开 sealed 块（组卡内）后，重渲染不强制收起（尊重用户）", () => {
    const view = renderMsg([thought("历史思考", 3000)], false);
    expect(screen.queryByText("历史思考")).toBeNull();
    fireEvent.click(screen.getByText(/思考 1 次/));
    expect(screen.getByText(/已思考 3 秒/)).toBeTruthy();
    fireEvent.click(screen.getByText(/已思考 3 秒/));
    expect(screen.getByText("历史思考")).toBeTruthy();
    // props 更新（引用变化）重渲染，局部 open state 不被重置
    rerenderMsg(view, [thought("历史思考", 3000)], false);
    expect(screen.getByText("历史思考")).toBeTruthy();
  });
});
