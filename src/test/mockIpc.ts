// 测试用 Tauri IPC mock 工具：让组件在 node/jsdom 里渲染时，所有 invoke 命令走可编程的假后端。
//
// 用法（在测试文件里）：
//   import { mockTauriIpc } from "../test/mockIpc";
//   beforeEach(() => mockTauriIpc({ adapters_list: [...], sessions_list: [...], ... }));
//
// 未在 handlers 里声明的命令默认 resolve(null)；需要记录调用次序/检查 payload 时，
// 用 `calls` 数组。

export interface MockIpcOptions {
  handlers?: Record<string, (args: any) => unknown>;
  calls?: Array<{ cmd: string; args: any }>;
}

/** 挂载（或重置）window.__TAURI_INTERNALS__，返回用于断言的 calls 数组 */
export function mockTauriIpc(opts: MockIpcOptions = {}): Array<{ cmd: string; args: any }> {
  const calls = opts.calls ?? [];
  const handlers = opts.handlers ?? {};

  const invoke = (cmd: string, args: any) => {
    calls.push({ cmd, args: args ?? {} });
    const h = handlers[cmd];
    if (h) {
      const r = h(args ?? {});
      return r instanceof Promise ? r : Promise.resolve(r);
    }
    return Promise.resolve(null);
  };

  (window as any).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback: () => Math.floor(Math.random() * 1e6),
    unregisterCallback: () => {},
    convertFileSrc: (p: string) => p,
  };
  return calls;
}
