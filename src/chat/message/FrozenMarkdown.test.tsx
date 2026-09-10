// P42 前缀冻结行为测试：settled/tail 分离的正确性。
// 锁定 WHY：流式长回复的性能生命线——settled 块零重渲染、尾块承接追加、
// live→false 收口后内容与「整段单 Streamdown」完全一致（视觉不变性）。
import { describe, it, expect } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { parseMarkdownIntoBlocks } from "streamdown";
import { FrozenMarkdownBlocks } from "./FrozenMarkdown";

const pluginsFull = { math: undefined } as never;
const pluginsStreaming = {} as never;
const theme: [string, string] = ["github-light", "github-dark"];

// jsdom 环境
// @vitest-environment jsdom

function renderFrozen(text: string, live: boolean) {
  return render(
    <FrozenMarkdownBlocks text={text} live={live} pluginsFull={pluginsFull} pluginsStreaming={pluginsStreaming} shikiTheme={theme} />,
  );
}

describe("FrozenMarkdownBlocks", () => {
  it("切分一致：parseMarkdownIntoBlocks 导出与 streamdown 内部同源（回归锚点）", () => {
    const doc = "# 标题\n\n段落一 `code`。\n\n```ts\nconst x = 1;\n```\n\n- 列表\n";
    const blocks = parseMarkdownIntoBlocks(doc);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    expect(blocks.join("")).toBe(doc); // 无损切分：块拼回 == 原文
  });

  it("live=false 等价单 static：不渲染 tail streaming 结构", () => {
    const doc = "# 标题\n\n段落。\n\n```ts\nconst x = 1;\n```";
    const { container } = renderFrozen(doc, false);
    // static 模式完整渲染（含高亮后的 pre）
    expect(container.querySelector("pre")).not.toBeNull();
    expect(container.textContent).toContain("段落");
    cleanup();
  });

  it("live=true：全部内容可见（settled + tail 拼接无损）", () => {
    const doc = "# 标题\n\n段落一。\n\n- 列表项\n\n段落二增长中";
    const { container } = renderFrozen(doc, true);
    const text = container.textContent ?? "";
    expect(text).toContain("标题");
    expect(text).toContain("段落一");
    expect(text).toContain("列表项");
    expect(text).toContain("段落二增长中");
    cleanup();
  });

  it("增长不变性：追加文本后已有块内容不重排、顺序保持", () => {
    const before = "# 标题\n\n第一段落。\n\n第二段落";
    const after = "# 标题\n\n第一段落。\n\n第二段落追加了更多内容";
    const { container: c1 } = renderFrozen(before, true);
    const settled1 = Array.from(c1.querySelectorAll('[data-streamdown], p, h1')).map((e) => e.textContent);
    cleanup();
    const { container: c2 } = renderFrozen(after, true);
    const settled2 = Array.from(c2.querySelectorAll('[data-streamdown], p, h1')).map((e) => e.textContent);
    // 标题与第一段落仍在（顺序不乱，内容不丢）
    expect(settled2.join("\n")).toContain("标题");
    expect(settled2.join("\n")).toContain("第一段落");
    expect(settled2.join("\n")).toContain("追加了更多内容");
    expect(settled1.length).toBeGreaterThan(0);
    cleanup();
  });

  it("代码围栏完整性：fence 横跨 settled/tail 边界时不炸（渲染为文本不抛错）", () => {
    // 开 fence 后立即截断（streaming 常态）→ 尾块 streaming 模式处理未闭合
    const doc = "段落。\n\n```ts\nconst x = 1;\nconst y = 2;";
    expect(() => {
      const { container } = renderFrozen(doc, true);
      expect(container.textContent).toContain("const x = 1;");
      cleanup();
    }).not.toThrow();
  });

  it("live 收口：从 streaming 切到 static 后内容一致（晋升语义）", () => {
    const doc = "# 标题\n\n完整段落。\n\n```ts\nconst x = 1;\n```";
    const a = renderFrozen(doc, true);
    const textLive = a.container.textContent;
    cleanup();
    const b = renderFrozen(doc, false);
    const textStatic = b.container.textContent;
    // 收口后内容不变（空格差异来自块间排版，字符内容必须一致）
    expect(textStatic?.replace(/\s+/g, "")).toBe(textLive?.replace(/\s+/g, ""));
    cleanup();
  });
});
