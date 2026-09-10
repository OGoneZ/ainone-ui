// @vitest-environment jsdom
// P43：回调 prop 引用稳定性 —— memo 不被每帧新引用击穿。
//
// 背景：ChatPanel 曾把 doFork/askRewind/startEdit/addDiffComment 直接写在 JSX 上
// （其中两个是内联箭头，捕获 vi.map 的 index），每次渲染都是新函数引用。MessageLine
// 与 BlockView 都用默认浅比较的 React.memo，函数 prop 一变即整行重渲染 →
// 流式期间视口内全部可见行每帧重跑 reconcile，并连带重算 ActivityGroupCard 的
// 文件变更 Myers diff（diff@9）。
//
// 断言语义（关键）：计数的是 MessageLine **内部真实渲染的子块**（BlockView），
// 不是包一层的宿主组件——只有前者能证明「行内 reconcile 被跳过」。
// 对照组用不稳定回调复现击穿，确保第一条不是空转（否则测试永远绿）。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { useStableCallback } from "@/chat/hooks/useStableCallback";
import type { ChatMsg } from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";

vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** BlockView 渲染计数桩：MessageLine 内唯一的块级子组件 */
let blockRenders = 0;
vi.mock("./BlockView", () => ({
  BlockView: () => {
    blockRenders++;
    return <div data-testid="block" />;
  },
}));

import { MessageLine } from "./MessageLine";

afterEach(() => {
  cleanup();
  blockRenders = 0;
});

const adapter: AdapterWithStatus = {
  id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".",
  logo: "#7c3aed", available: true, state: "ready",
  bridge: null, cli: null, auth: { state: "none", detail: "" },
  resolvedPath: null, source: null,
};

const msg: ChatMsg = { role: "assistant", blocks: [{ kind: "text", text: "历史回复" }] };

/** 稳定回调版宿主：回调经 useStableCallback 包装（= ChatPanel 修复后的接线） */
function StableHost({ tick }: { tick: number }) {
  void tick; // 无关状态：模拟流式期间父级每帧提交
  const onFork = useStableCallback(() => {});
  const onRewind = useStableCallback((_i: number) => {});
  const onEdit = useStableCallback((_i: number) => {});
  const onAddDiffComment = useStableCallback(() => {});
  return (
    <MessageLine
      msg={msg} index={0} adapter={adapter} busy={false} isLast={false}
      onFork={onFork} onRewind={onRewind} onEdit={onEdit} onAddDiffComment={onAddDiffComment}
    />
  );
}

/** 不稳定回调版宿主：等价于修复前的 JSX 内联箭头（对照组） */
function UnstableHost({ tick }: { tick: number }) {
  void tick;
  return (
    <MessageLine
      msg={msg} index={0} adapter={adapter} busy={false} isLast={false}
      onFork={() => {}}
      onRewind={(_i: number) => {}}
      onEdit={(_i: number) => {}}
      onAddDiffComment={() => {}}
    />
  );
}

describe("P43 回调引用稳定性", () => {
  it("稳定回调：父级无关重渲染不进入行内 reconcile（子块渲染计数不增）", () => {
    const { rerender } = render(<StableHost tick={0} />);
    expect(blockRenders).toBe(1);

    for (let i = 1; i <= 5; i++) rerender(<StableHost tick={i} />);
    // 父级渲染 6 次，但 MessageLine memo 命中 → 子块只在首次渲染
    expect(blockRenders).toBe(1);
  });

  it("对照组：回调每帧新引用时 memo 击穿（证明上一条能失败，非空转）", () => {
    const { rerender } = render(<UnstableHost tick={0} />);
    expect(blockRenders).toBe(1);

    for (let i = 1; i <= 5; i++) rerender(<UnstableHost tick={i} />);
    // 与稳定版对照：这里必然被击穿，子块每帧重渲染
    expect(blockRenders).toBe(6);
  });

  it("index 由行内绑定：onRewind/onEdit 收到本行序号（不再依赖父级捕获）", () => {
    const rewindArgs: number[] = [];
    const editArgs: number[] = [];
    const userMsg: ChatMsg = { role: "user", text: "你好" };
    const { getByLabelText } = render(
      <MessageLine
        msg={userMsg} index={7} adapter={adapter} busy={false} isLast={false}
        onRewind={(i) => rewindArgs.push(i)}
        onEdit={(i) => editArgs.push(i)}
      />,
    );
    getByLabelText("回溯到这里").click();
    getByLabelText("编辑并重发").click();
    expect(rewindArgs).toEqual([7]);
    expect(editArgs).toEqual([7]);
  });
});
