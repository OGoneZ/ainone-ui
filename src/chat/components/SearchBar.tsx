// F-9-2 会话内搜索条：关键词输入 + 命中计数 + 上下条导航（Enter/Shift+Enter）。
// 自 ChatPanel 拆出（P13 C3c）：纯展示组件，搜索状态与跳转逻辑留在 ChatPanel。

import { CloseIcon } from "@/components/ui/icons";

export function SearchBar({
  keyword,
  onKeywordChange,
  countText,
  inputRef,
  onHit,
  onClose,
}: {
  keyword: string;
  onKeywordChange: (v: string) => void;
  /** "3 / 10" / "无结果" / "" —— 由 ChatPanel 按命中列表计算 */
  countText: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  /** delta: 1 = 下一条（Enter），-1 = 上一条（Shift+Enter） */
  onHit: (delta: 1 | -1) => void;
  onClose: () => void;
}) {
  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        aria-label="搜索会话"
        className="search-input"
        placeholder="搜索会话内容…（Enter 下一条 / Shift+Enter 上一条）"
        value={keyword}
        onChange={(e) => onKeywordChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onHit(1);
          } else if (e.key === "Enter" && e.shiftKey) {
            e.preventDefault();
            onHit(-1);
          }
        }}
      />
      <span className="search-count">{countText}</span>
      <button type="button" className="search-close" aria-label="关闭搜索" onClick={onClose}>
        <CloseIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
      </button>
    </div>
  );
}
