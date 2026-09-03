// P11 渲染增强 · 视觉验收假会话（F-R1..R8 全覆盖）。
// 零 Tauri 依赖、零网络请求：数据全部由下面三个 seed 函数静态构造，
// 直接灌进 useSessionStore（与生产同一数据模型 ChatMsg/BlockMsg/ToolContent）。
// 顶栏提供浅色/深色切换，方便双主题核对（AC-R2-3 / AC-R5-4）。

import { useEffect, useMemo, useState } from "react";
import { useSessionStore, type ChatMsg, type CommandWord } from "../store/sessionStore";
import type { BlockMsg } from "../acp/message-log";
import type { ToolContent } from "../acp/session-core";
import { ChatPanel } from "../components/ChatPanel";
import type { AdapterWithStatus } from "../config/adapters";

// —— 样例文本块 ——————————————————————————————————————————————

const GFM_DEMO = `# 一级标题：P11 渲染增强验收
## 二级标题：GFM 全要素
### 三级标题：列表与引用

普通段落，含 **加粗**、*斜体*、~~删除线~~、\`行内代码\`、以及[一个链接](https://github.com/vercel/streamdown)。

> 引用块：Streamdown 是 Vercel 为 AI 流式设计的 react-markdown 替代品，
> 内建 remend 不完整块兜底与 rehype-harden 安全加固。

任务列表：
- [x] F-R1 消息渲染切换 Streamdown
- [x] F-R2 代码块增强
- [ ] F-R5 人工核对深色主题
- [ ] F-R6 人工核对 ANSI 配色

宽表格（横向滚动，表头有底色）：

| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 | 列七 | 列八 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| alpha | beta | gamma | delta | epsilon | zeta | eta | theta |
| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |

分隔线：

---

- [GFM 文档](https://github.github.com/gfm/)
- [Streamdown](https://streamdown.ai)`;

const HTML_SECURITY_DEMO = `## 安全基线（AC-R1-4）

下面这行是 LLM 输出的 raw script，应显示为纯文本而不是执行：

<script>alert("xss")</script>

再补一个 img onerror 样例：<img src="x" onerror="alert(2)" />`;

const MERMAID_DEMO = `## Mermaid 图（F-R3）

\`\`\`mermaid
graph TD
    A[收到用户消息] --> B{是否需要工具?}
    B -->|是| C[发起 tool_call]
    B -->|否| D[直接回复]
    C --> E{用户批准?}
    E -->|允许| F[执行并回传结果]
    E -->|拒绝| G[降级回复]
    F --> D
\`\`\`

非法 mermaid（应显示错误占位，不崩溃，AC-R3-2）：

\`\`\`mermaid
graph TD
    A[ --> 这不是合法语法
\`\`\``;

const MATH_DEMO = `## 数学公式（F-R4）

行内公式：质能方程 $$E = mc^2$$ 是物理学中最著名的等式。

块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

美元符号不应被误判（AC-R4-3）：这台机器价格 $5，那台 $12。`;

const CODE_DEMO = `## 代码块（F-R2）

TypeScript（含语言标签、复制按钮、行号）：

\`\`\`typescript
interface Agent {
  id: string;
  name: string;
  run(prompt: string): AsyncIterable<string>;
}

export async function* stream(agent: Agent, prompt: string) {
  for await (const chunk of agent.run(prompt)) {
    yield chunk.toUpperCase();
  }
}
\`\`\`

超宽行（横向滚动，不撑破气泡，AC-R2-4）：

\`\`\`bash
curl -sS -X POST http://localhost:8080/api/v1/sessions -H 'Content-Type: application/json' -H 'Authorization: Bearer very-long-token-abcdefghijklmnopqrstuvwxyz0123456789' -d '{"prompt":"hello","stream":true,"options":{"temperature":0.7,"max_tokens":4096}}'
\`\`\``;

// —— 样例工具内容 ——————————————————————————————————————————————

const ANSI_OUTPUT = "11;36m[1m[32m✓[0m 编译通过 [1m[33m[12.4s][0m\n[31m✗[0m 3 个用例失败\n  [2m→ src/render.test.ts:42[0m\n全部 [1m196[0m 个用例完成";

const JSON_OUTPUT = '{"id":"sess_9f2c","model":"claude-opus-5","usage":{"input_tokens":1523,"output_tokens":412,"cache_read":0},"stop_reason":"end_turn","tools_used":["read_file","bash"]}';

const LONG_OUTPUT = Array.from({ length: 120 }, (_, i) => `[2026-09-03 22:${String(i % 60).padStart(2, "0")}:11] [trace] worker-${i % 4} processed frame ${i} in ${20 + (i * 7) % 180}ms`).join("\n");

function toolContents(): ToolContent[] {
  return [
    { kind: "text", text: JSON_OUTPUT },
    { kind: "text", text: ANSI_OUTPUT },
    { kind: "text", text: LONG_OUTPUT },
    { kind: "text", text: "这是一段普通纯文本输出： npm error code E404，不应被当成 JSON。" },
    {
      kind: "diff",
      diff: {
        path: "src/components/ChatPanel.tsx",
        oldText: "import ReactMarkdown from \"react-markdown\";\nimport rehypeHighlight from \"rehype-highlight\";",
        newText: "import { Streamdown } from \"streamdown\";\nimport { code } from \"@streamdown/code\";",
      },
    },
    { kind: "terminal", terminal: { terminalId: "term-3" } },
  ];
}

// —— 假会话消息流 ——————————————————————————————————————————————

function demoMessages(): ChatMsg[] {
  const blocks: BlockMsg[] = [
    { kind: "text", text: "我先分析一下当前渲染链路的现状……" },
    { kind: "thought", text: "正在评估 react-markdown 与 Streamdown 的差异：\n- Streamdown 内建 remend 兜底\n- shiki 高亮质量更好\n- 体积可接受\n结论：切换。" },
    { kind: "tool", toolCallId: "t1", title: "查看依赖 package.json", status: "completed", content: toolContents() },
    { kind: "text", text: "依赖清理完毕。接下来是正文渲染验证：\n\n" + GFM_DEMO },
    { kind: "tool", toolCallId: "t2", title: "渲染安全性自检", status: "completed", content: [{ kind: "text", text: "无 script 执行路径" }] },
    { kind: "text", text: HTML_SECURITY_DEMO },
    { kind: "text", text: MERMAID_DEMO },
    { kind: "text", text: MATH_DEMO },
    { kind: "text", text: CODE_DEMO },
    { kind: "text", text: "## 图片（F-R5，点击可放大）\n\n![示例图](https://picsum.photos/seed/p11a/640/360)\n\n![第二张](https://picsum.photos/seed/p11b/640/360)" },
  ];
  return [
    { role: "user", text: "把 P11 渲染增强的所有特性展示出来，我要逐项验收。" },
    { role: "assistant", blocks },
  ];
}

// —— 组件 ——————————————————————————————————————————————

const DEMO_ADAPTER: AdapterWithStatus = {
  id: "omp",
  name: "Oh My Pi（demo）",
  program: "omp",
  args: [],
  cwd: ".",
  logo: "#7c3aed",
  available: true,
};

const DEMO_COMMANDS: CommandWord[] = [
  { name: "model", description: "切换模型" },
  { name: "fast", description: "快速模式" },
  { name: "review", description: "审查当前改动" },
];

export function DemoApp() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // 只灌一次（StrictMode 会双调 useEffect，ensure 幂等 + setMessages 覆盖即可）
  useEffect(() => {
    const st = useSessionStore.getState();
    st.ensure("demo", DEMO_ADAPTER.id);
    st.setMessages("demo", demoMessages());
    st.setCommands(DEMO_ADAPTER.id, DEMO_COMMANDS);
  }, []);

  const messages = useSessionStore((s) => s.runtime["demo"]?.messages);
  const seeded = useMemo(() => (messages ?? []).length > 0, [messages]);

  if (!seeded) return <div style={{ padding: 24 }}>正在装载演示会话…</div>;

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          padding: "8px 16px",
          borderBottom: "1px solid var(--bg-3)",
          background: "var(--bg-1)",
        }}
      >
        <strong>P11 渲染增强 · 视觉验收会话</strong>
        <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>
          逐条滚动核对：GFM → 安全 → mermaid → 公式 → 代码块 → 图片 → 工具输出
        </span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}>
          切到{theme === "light" ? "深色" : "浅色"}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatPanel tabKey="demo" adapter={DEMO_ADAPTER} />
      </div>
    </div>
  );
}
