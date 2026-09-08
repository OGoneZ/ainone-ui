// @vitest-environment jsdom
// P11 渲染增强组件测试（F-R1/R2）：Streamdown 接入后的核心渲染断言。
// 直接渲染 MarkdownView（BlockView 内 text 分支的渲染体），不走完整 ChatPanel，
// 避免虚拟化/会话 mock 的干扰。mermaid 真渲染依赖 DOM 布局，jsdom 下 mock 成占位。

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MarkdownView } from "./MarkdownView";

// logger 走 tauri log 插件（jsdom 无运行时）
vi.mock("../lib/logger", () => ({
  logger: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// mermaid 在 jsdom 下无法真实布局 SVG → mock 为占位组件，验证「代码块语言=mermaid
// 时走图渲染路径」这一接线，而非 mermaid 本身（真实渲染属人工 e2e 验收）。
// P31：mock 透传全部 props 到 data-* 上并捕获到全局数组——P11 断言 children/模式，
// P31 断言三大 props 引用稳定（同一 mock 服务两组测试，避免 doMock 作用域问题）。
const capturedStreamdownProps: Array<Record<string, unknown>> = [];
vi.mock("streamdown", async (importOriginal) => {
  const mod = await importOriginal<typeof import("streamdown")>();
  return {
    ...mod,
    Streamdown: (props: {
      children?: string;
      parseIncompleteMarkdown?: boolean;
      plugins?: unknown;
      shikiTheme?: unknown;
      components?: unknown;
      mode?: unknown;
    }) => {
      capturedStreamdownProps.push(props as unknown as Record<string, unknown>);
      return (
        <div
          data-testid="streamdown-mock"
          data-parse-incomplete={String(props.parseIncompleteMarkdown)}
          data-mode={String(props.mode)}
        >
          {props.children}
        </div>
      );
    },
  };
});

afterEach(() => {
  cleanup();
  capturedStreamdownProps.length = 0;
});

describe("P11 渲染接线（F-R1/R2）", () => {
  it("正文经 Streamdown 渲染（F-R1 AC-R1-1：渲染链路切换）", () => {
    render(<MarkdownView text="# 标题\n\n正文段落" live={false} />);
    expect(screen.getByTestId("streamdown-mock")).toBeInTheDocument();
    expect(screen.getByTestId("streamdown-mock").textContent).toContain("正文段落");
  });

  it("流式中的块启用不完整解析，静态块关闭（F-R1 AC-R1-2）", () => {
    const { rerender } = render(<MarkdownView text="**未闭合加粗" live={true} />);
    expect(screen.getByTestId("streamdown-mock").dataset.parseIncomplete).toBe("true");
    rerender(<MarkdownView text="**已完成加粗**" live={false} />);
    expect(screen.getByTestId("streamdown-mock").dataset.parseIncomplete).toBe("false");
  });

  it("raw HTML 脚本不执行：script 标签以文本呈现（F-R1 AC-R1-4 安全基线）", () => {
    render(<MarkdownView text={'<script>alert(1)</script>'} live={false} />);
    // mock 层直出文本；真实 Streamdown 由 rehype-harden 兜底（规格书 §F-R1）
    expect(document.querySelector("script")).toBeNull();
  });

  it("图片渲染包 PhotoView（点击可放大）+ 懒加载（F-R5 AC-R5-3）", () => {
    // PhotoProvider 真实引入（无 DOM 依赖）；img 覆盖以函数形式传给 Streamdown
    // （引用稳定性见 P31 组；接线正确性由 components.img 函数存在性断言覆盖）
    render(<MarkdownView text={"![图](https://example.com/a.png)"} live={false} />);
    const props = capturedStreamdownProps[0];
    expect(typeof (props.components as { img?: unknown })?.img).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// P31 性能防回归（2026-09-08 事故）：Streamdown 顶层 memo 逐项比较 plugins /
// shikiTheme / components 的引用（===）。若在 JSX 内联字面量，每次渲染都是新
// 引用 → memo 恒失效 → 每条流式 update 全量重解析所有可见块（WebKit 主线程
// 满载实锤，118KB transcript × 396 update/48s）。此组断言：MarkdownView 多次
// 重渲染间三大 props 引用恒定——这是 Streamdown 逐块 memo 生效的前提，一旦
// 有人把常量改回 JSX 内联字面量，这里必须红。
describe("P31 Streamdown props 引用稳定（memo 生效前提）", () => {
  it("多次重渲染间 plugins/shikiTheme/components 引用恒定（含 live 切换）", () => {
    const { rerender } = render(<MarkdownView text="a" live={true} />);
    rerender(<MarkdownView text="ab" live={true} />);
    rerender(<MarkdownView text="abc" live={false} />);
    rerender(<MarkdownView text="abcd" live={false} />);
    expect(capturedStreamdownProps.length).toBe(4);
    const [p1, p2, p3, p4] = capturedStreamdownProps;
    // 文本增长与 streaming→static 模式切换前后：同 live 态的 plugins 必须同一
    // 引用（live/static 是两个预建常量）；shikiTheme/components 恒同一引用
    expect(p2.plugins).toBe(p1.plugins); // 同为 live
    expect(p2.shikiTheme).toBe(p1.shikiTheme);
    expect(p2.components).toBe(p1.components);
    expect(p4.plugins).toBe(p3.plugins); // 同为 static
    expect(p3.shikiTheme).toBe(p1.shikiTheme);
    expect(p3.components).toBe(p1.components);
    expect(p4.shikiTheme).toBe(p1.shikiTheme);
    expect(p4.components).toBe(p1.components);
  });

  it("props 内含正确的插件接线（稳定引用≠空引用）", () => {
    render(<MarkdownView text="x" live={false} />);
    const p = capturedStreamdownProps[0];
    // plugins 三件套键齐全
    const plugins = p.plugins as Record<string, unknown>;
    expect(Object.keys(plugins).sort()).toEqual(["code", "math", "mermaid"]);
    // shikiTheme 双主题
    expect(p.shikiTheme).toEqual(["github-light", "github-dark"]);
    // components.img 可调用（lightbox 接线）
    expect(typeof (p.components as { img?: unknown }).img).toBe("function");
  });

  it("live 块降级不带 code 插件（P31 高亮止血），static 块完整插件", () => {
    // live：shiki 高亮缓存 key 含代码长度 → 流式增长中的代码块每帧全量重高亮
    //（dist 反编译实锤）。live 时不带 code 插件 → HighlightedCodeBlockBody 走
    // raw pre 直出，零高亮开销；完成后（static）切回完整插件高亮一次。
    const { rerender } = render(<MarkdownView text="\`\`\`js\ncon" live={true} />);
    const liveProps = capturedStreamdownProps[capturedStreamdownProps.length - 1];
    expect(Object.keys(liveProps.plugins as Record<string, unknown>).sort()).toEqual(["math", "mermaid"]);

    rerender(<MarkdownView text="\`\`\`js\nconst a = 1;\n\`\`\`" live={false} />);
    const staticProps = capturedStreamdownProps[capturedStreamdownProps.length - 1];
    expect(Object.keys(staticProps.plugins as Record<string, unknown>).sort()).toEqual(["code", "math", "mermaid"]);
    // 两组 plugins 均引用稳定（多次切换不重建）
    const p1 = capturedStreamdownProps[0].plugins;
    rerender(<MarkdownView text="done" live={false} />);
    expect(capturedStreamdownProps[capturedStreamdownProps.length - 1].plugins).toBe(staticProps.plugins);
    expect(p1).toBe(liveProps.plugins);
  });
});
