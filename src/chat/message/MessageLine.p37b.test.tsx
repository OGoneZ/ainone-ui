// @vitest-environment jsdom
// P37b：流式轮次不得隐藏历史轮的冻结「用时/速率」行。
// 用户实测回归：第 2/3 轮输出期间（busy=true），前几轮 assistant 消息的
// turn-elapsed-ended 行消失，直到本轮收口才回显——根因是结束态渲染条件
// 用了全局 !busy（对每条消息的「本条是否在流式」判定是错的）。
// 修正后条件：!(busy && isLast)——只有当前正在流式的那一条不显示结束态，
// 历史轮的 turnMs/rateTokPerS 全程可见。

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MessageLine } from "@/chat/message/MessageLine";
import type { ChatMsg } from "@/store/sessionStore";
import type { AdapterWithStatus } from "@/ipc/adapters";
import { useSessionStore } from "@/store/sessionStore";

const adapter = {
  id: "omp", name: "Oh My Pi", program: "omp", args: [], cwd: ".", logo: "#7c3aed",
  available: true, state: "ready" as const, resolvedPath: null, source: null, bridge: null, cli: null, auth: { state: "none", detail: "" },
} as unknown as AdapterWithStatus;

const msgs: ChatMsg[] = [
  { role: "user", text: "第一问" },
  { role: "assistant", blocks: [{ kind: "text", text: "第一轮回答" }], turnMs: 12_000, rateTokPerS: 25 },
  { role: "user", text: "第二问" },
  { role: "assistant", blocks: [{ kind: "text", text: "第二轮回答" }] },
];

function renderAll(busy: boolean) {
  return msgs.map((m, i) => (
    <MessageLine
      key={i}
      msg={m}
      index={i}
      adapter={adapter}
      busy={busy}
      isLast={i === msgs.length - 1}
      lastEventAt={busy && i === msgs.length - 1 ? Date.now() : undefined}
      ownerTabKey="k1"
    />
  ));
}

describe("P37b：历史轮冻结行在流式期间保持可见", () => {
  afterEach(() => cleanup());

  it("第一轮带 turnMs/rateTokPerS：busy=false 时显示结束态行", () => {
    render(<div>{renderAll(false)}</div>);
    expect(screen.getByText(/用时 12 秒/)).toBeInTheDocument();
    expect(screen.getByTestId("stream-rate")).toHaveTextContent("25 tok/s");
  });

  it("修复点：busy=true（第 2 轮流式中）时，第一轮冻结行仍然显示", () => {
    render(<div>{renderAll(true)}</div>);
    // 历史轮（index 1）不是 isLast → 其结束态行不因全局 busy 被藏
    expect(screen.getByText(/用时 12 秒/)).toBeInTheDocument();
    expect(screen.getByTestId("stream-rate")).toHaveTextContent("25 tok/s");
    // 末条（isLast，无 turnMs）→ 无结束态行、只有一条 stream-rate（第一轮的）
    expect(screen.getAllByTestId("stream-rate")).toHaveLength(1);
  });
});
