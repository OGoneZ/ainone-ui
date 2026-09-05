// 「历史」面板（P16 · F-16-2，DEC-49）：用户消息锚点列表。
//
// 点击条目 → CustomEvent("ainone:jump-message") 跳转到该消息；
// 回溯小钮 → CustomEvent("ainone:rewind-request")（ChatPanel 复用既有
// 确认 Dialog + busy 保护链路）。事件模式与 ref-file/open-file 同款解耦。

import { useMemo } from "react";
import { extractUserAnchors } from "./historyAnchors";
import { Undo2Icon } from "lucide-react";
import type { ChatMsg } from "@/acp/message-log";
import { logger } from "@/lib/logger";

interface Props {
  messages: ChatMsg[];
}

export function HistoryPanel({ messages }: Props) {
  const anchors = useMemo(() => extractUserAnchors(messages), [messages]);

  function jump(index: number, preview: string) {
    logger.info("history", "jump", { index });
    window.dispatchEvent(new CustomEvent("ainone:jump-message", { detail: { index, preview } }));
  }

  function requestRewind(index: number, preview: string) {
    logger.info("history", "rewind-request", { index });
    window.dispatchEvent(new CustomEvent("ainone:rewind-request", { detail: { index, preview } }));
  }

  if (anchors.length < 2) {
    return <div className="hint">历史消息会在对话后出现在这里。</div>;
  }

  return (
    <div className="history" data-testid="history-panel">
      <div className="history-head">历史消息 · {anchors.length}</div>
      <ul className="history-list" role="list">
        {anchors.map((a, i) => (
          <li key={a.index} className="history-item">
            <button
              type="button"
              className="history-jump"
              title={a.text}
              onClick={() => jump(a.index, a.preview)}
            >
              <span className="history-no">#{i + 1}</span>
              <span className="history-preview">{a.preview}</span>
            </button>
            <button
              type="button"
              className="history-rewind"
              aria-label={`回溯到第 ${i + 1} 条消息`}
              title="回溯到这里"
              onClick={() => requestRewind(a.index, a.preview)}
            >
              <Undo2Icon style={{ width: 13, height: 13, strokeWidth: 1.75 }} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
