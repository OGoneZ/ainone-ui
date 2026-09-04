// Markdown 渲染（P11）：Streamdown + 图片 lightbox + 选区批注监听。
// 自 ChatPanel 拆出（P13 C3）。导出供测试与复用。

import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { math } from "@streamdown/math";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";

/** P11：assistant 正文 markdown 渲染（导出供测试与复用；批注选区监听在容器上） */
export function MarkdownView({
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
          live 块必须用 streaming 模式，静态消息保持 static（走 memo 快路径）。 */}
      {/* F-R5 图片 lightbox（DEC-24）：md 内 img 全部可点击放大（缩放/Esc 关闭） */}
      <PhotoProvider>
        <Streamdown
          mode={live ? "streaming" : "static"}
          parseIncompleteMarkdown={live}
          plugins={{ code, mermaid, math }}
          shikiTheme={["github-light", "github-dark"]}
          components={{
            img: ({ src, alt }) => (
              <PhotoView src={typeof src === "string" ? src : undefined}>
                <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} loading="lazy" />
              </PhotoView>
            ),
          }}
        >
          {text}
        </Streamdown>
      </PhotoProvider>
    </div>
  );
}
