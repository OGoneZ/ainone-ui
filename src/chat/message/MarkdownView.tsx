// Markdown 渲染（P11）：Streamdown + 图片 lightbox + 选区批注监听。
// 自 ChatPanel 拆出（P13 C3）。导出供测试与复用。

import { memo } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";

// 性能（2026-09-08 事故）：Streamdown 顶层 memo 逐项比较 plugins/shikiTheme/components
// 的引用（===）。此三者若在 JSX 内联字面量，每次渲染都是新引用 → memo 恒失效 →
// 每条流式 update 到达时所有可见块全量重解析重渲染（WebKit 主线程满载实锤）。
// 提为模块级常量保引用稳定，Streamdown 逐块 memo 恢复工作（仅增长尾块重渲染）。
//
// P31 代码块高亮止血：@streamdown/code 的高亮缓存 key 含代码长度
// （len:head100:tail100，dist 反编译实锤）→ 流式增长中的代码块永不命中缓存，
// 每帧全量重高亮（shiki codeToTokens 跑在主线程）。live 块用不含 code 插件的
// PLUGINS_STREAMING（shiki 缺席时 HighlightedCodeBlockBody 走 raw pre 直出，
// 零高亮开销）；块完成（live=false）后切回含 code 的完整插件，走缓存高亮一次。
// 两组引用均模块级稳定，memo 语义不受影响。
const STREAMDOWN_PLUGINS = { code, mermaid, math };
const STREAMDOWN_PLUGINS_STREAMING = { mermaid, math };
const STREAMDOWN_SHIKI_THEME: [string, string] = ["github-light", "github-dark"];
const STREAMDOWN_COMPONENTS = {
  img: ({ src, alt }: { src?: string; alt?: string }) => (
    <PhotoView src={typeof src === "string" ? src : undefined}>
      <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" />
    </PhotoView>
  ),
};

/** P11：assistant 正文 markdown 渲染（导出供测试与复用；批注选区监听在容器上）。
 *  P32 R5：memo 化——MessageLine 重渲染（如 diffComments/activityOverride 变化）
 *  时，text/live/onSelect 引用未变的块跳过整棵 Streamdown 子树 reconcile。
 *  onSelect 来自 ChatPanel useCallback（P11 F-R7 已稳定）。 */
export const MarkdownView = memo(function MarkdownView({
  text,
  live,
  onSelect,
}: {
  text: string;
  live: boolean;
  onSelect?: (text: string, e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="md"
      onMouseUp={(e) => {
        // F-8-2（用法1）+ F-8-7（快问）：选中 assistant 正文文字 → 记录选区
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) return;
        const t = sel.toString().trim();
        if (t) onSelect?.(t, e);
      }}
    >
      {/* P11（DEC-21）：Streamdown 替代 ReactMarkdown——GFM/代码块(Shiki)/Mermaid/
          KaTeX/不完整块兜底/内部 memo 一体化；shikiTheme 双主题走 CSS 变量，
          深色由 data-theme 驱动（@custom-variant dark 对齐）。
          H1 修复：parseIncompleteMarkdown 仅在 mode="streaming" 下生效（库实现），
          live 块必须用 streaming 模式，静态消息保持 static（走 memo 快路径）。
          P31 性能：plugins/shikiTheme/components 必须引用稳定（见顶部注释），
          禁止改回 JSX 内联字面量。 */}
      {/* F-R5 图片 lightbox（DEC-24）：md 内 img 全部可点击放大（缩放/Esc 关闭） */}
      <PhotoProvider>
        <Streamdown
          mode={live ? "streaming" : "static"}
          parseIncompleteMarkdown={live}
          plugins={live ? STREAMDOWN_PLUGINS_STREAMING : STREAMDOWN_PLUGINS}
          shikiTheme={STREAMDOWN_SHIKI_THEME}
          components={STREAMDOWN_COMPONENTS}
        >
          {text}
        </Streamdown>
      </PhotoProvider>
    </div>
  );
});
