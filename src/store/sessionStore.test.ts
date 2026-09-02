import { describe, it, expect, beforeEach } from "vitest";
import { useSessionStore } from "./sessionStore";
import type { BlockMsg } from "../acp/message-log";

// 注：persist 中间件在 node 环境下会尝试读 localStorage，zustand 内部会吞掉异常
// （非浏览器环境无 localStorage），故直接操作 store 实例即可。

function resetStore() {
  useSessionStore.setState({
    runtime: {},
    commands: {},
  });
}

describe("会话运行时 store", () => {
  beforeEach(resetStore);

  it("ensure 幂等创建运行时，drop 移除", () => {
    useSessionStore.getState().ensure("k1", "omp");
    expect(useSessionStore.getState().runtime["k1"]).toMatchObject({ adapterId: "omp" });
    useSessionStore.getState().ensure("k1", "omp"); // 二次幂等
    useSessionStore.getState().drop("k1");
    expect(useSessionStore.getState().runtime["k1"]).toBeUndefined();
  });

  it("appendUser 追加右气泡，updateLastAssistant 无 turn 时新起 turn", () => {
    const s = useSessionStore.getState();
    s.ensure("k", "omp");
    s.appendUser("k", "你好");
    s.updateLastAssistant("k", (b) => [...b, { kind: "text", text: "你好！" }]);
    const msgs = useSessionStore.getState().runtime["k"].messages;
    expect(msgs).toEqual([
      { role: "user", text: "你好" },
      { role: "assistant", blocks: [{ kind: "text", text: "你好！" }] },
    ]);
  });

  it("updateLastAssistant 追加块到最后一个 assistant turn（流式分块不拆消息）", () => {
    const s = useSessionStore.getState();
    s.ensure("k", "omp");
    s.appendUser("k", "1+1");
    s.updateLastAssistant("k", (b) => [...b, { kind: "text", text: "2" }]);
    s.updateLastAssistant("k", (b) => {
      const copy = b.slice();
      copy[copy.length - 1] = { kind: "text", text: "2 是答案" };
      return copy;
    });
    const msgs = useSessionStore.getState().runtime["k"].messages;
    // 仍是 2 条（1 user + 1 assistant），assistant 只有一个 text 块
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toEqual({ role: "assistant", blocks: [{ kind: "text", text: "2 是答案" }] });
  });

  it("bindSession 与 patch 更新标量", () => {
    const s = useSessionStore.getState();
    s.ensure("k", "omp");
    s.bindSession("k", "sid-1");
    s.patch("k", { busy: true });
    const r = useSessionStore.getState().runtime["k"];
    expect(r.sessionId).toBe("sid-1");
    expect(r.busy).toBe(true);
  });

  it("setMessages 整体回填（历史恢复），setCommands 覆盖命令缓存", () => {
    const s = useSessionStore.getState();
    s.ensure("k", "omp");
    s.setMessages("k", [{ role: "user", text: "旧消息" }]);
    s.setCommands("omp", [{ name: "model", description: "显示模型" }]);
    expect(useSessionStore.getState().runtime["k"].messages).toEqual([{ role: "user", text: "旧消息" }]);
    expect(useSessionStore.getState().commands["omp"]).toHaveLength(1);
  });

  it("对不存在的 tabKey 操作都是无副作用 no-op", () => {
    const s = useSessionStore.getState();
    const before = useSessionStore.getState();
    s.appendUser("ghost", "x");
    s.updateLastAssistant("ghost", (b: BlockMsg[]) => b);
    s.patch("ghost", { busy: true });
    s.setMessages("ghost", []);
    // no-op：无 ghost key，runtime/commands 内容不变
    expect(useSessionStore.getState().runtime).toEqual(before.runtime);
    expect(useSessionStore.getState().runtime["ghost"]).toBeUndefined();
  });
});
