// F-8-7 快问悬浮窗：选中文本 → 批注/快速解释入口 → 结果/错误三态。
// F-11-6：点外/Esc 关闭（监听在 ChatPanel 容器上，本组件只渲染）。
// H6：absolute 定位锚点由 ChatPanel 换算为 .chat 内容区坐标后经 props 传入。
// 自 ChatPanel 拆出（P13 C3b）。P27c：解释正文走 MarkdownView（复用消息域
// Streamdown 渲染，流式中 live=true 不完整块兜底），与消息区观感一致。

import { toast } from "sonner";
import { MarkdownView } from "../message/MarkdownView";

export interface QuickAskState {
  /** 选中的待解释文本（null = 悬浮窗关闭） */
  quickSel: string;
  /** null = 等待用户选择动作；streaming/ok/error 三态（P27：流式中边收边渲染） */
  quickPop: { state: "streaming" | "ok" | "error"; text: string } | null;
  anchor: { x: number; y: number };
  /** 快问模型是否已配置（未配置则「快速解释」禁用） */
  ready: boolean;
}

export function QuickAskPopup({
  state,
  popRef,
  onAnnotate,
  onQuickAsk,
  onClose,
}: {
  state: QuickAskState;
  popRef: React.RefObject<HTMLDivElement | null>;
  onAnnotate: () => void;
  onQuickAsk: () => void;
  onClose: () => void;
}) {
  const { quickSel, quickPop, anchor, ready } = state;
  return (
    <div
      className="quick-pop"
      ref={popRef}
      data-testid="quick-pop"
      style={{
        position: "absolute",
        top: anchor.y,
        left: anchor.x,
        zIndex: "var(--z-popover, 50)",
      }}
    >
      {!quickPop ? (
        <>
          <div className="quick-pop-title">对选中文本：</div>
          <div className="quick-pop-sel" title={quickSel}>{quickSel}</div>
          <div className="quick-pop-actions">
            {/* 统一入口（ideas IDEA-001）：批注＝加入批注卡；快速解释＝独立轻量模型 */}
            <button type="button" onClick={onAnnotate}>
              批注
            </button>
            <button
              type="button"
              disabled={!ready}
              title={ready ? "" : "未配置快问模型"}
              onClick={onQuickAsk}
            >
              快速解释
            </button>
          </div>
        </>
      ) : quickPop.state === "error" ? (
        <div className="quick-pop-body quick-pop-error">解释失败：{quickPop.text}</div>
      ) : (
        <>
          {/* P27c 流式：streaming 与 ok 共用渲染体，MarkdownView live 跟随流式态
              （streaming 下 Streamdown 解析不完整 markdown 块不闪断） */}
          <div className="quick-pop-body" data-streaming={quickPop.state === "streaming"}>
            <MarkdownView
              text={quickPop.text}
              live={quickPop.state === "streaming"}
            />
            {quickPop.state === "streaming" && <span className="quick-pop-caret" />}
          </div>
          <div className="quick-pop-actions">
            {quickPop.state === "ok" && (
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(quickPop.text).then(
                    () => toast.success("已复制"),
                    () => toast.error("复制失败"),
                  );
                }}
              >
                复制
              </button>
            )}
          </div>
        </>
      )}
      {/* 关闭经点外/Esc（ChatPanel 监听），onClose 供语义补全 */}
      <span hidden onClick={onClose} />
    </div>
  );
}
