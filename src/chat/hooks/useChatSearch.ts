// F-9-2 会话内搜索状态机：关键词/命中/下标 + 跳转与关闭。
// 自 ChatPanel 拆出（P13 C3d）：虚拟列表句柄经 props 注入（跳转依赖 scrollToIndex）。
// M8 双帧校跳逻辑逐字随迁。

import { useEffect, useRef, useState } from "react";
import { searchMessages } from "@/chat/logic/search";
import type { ChatMsg } from "@/store/sessionStore";
import { logger } from "@/lib/logger";

/** 与 @tanstack/react-virtual 的 scrollToIndex 形状对齐的最小接口（避免泛型耦合） */
interface JumpCapable {
  scrollToIndex: (index: number, opts: { align: "start" | "center" | "end" }) => void;
}

export function useChatSearch(messages: ChatMsg[], virtualizer: JumpCapable) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);

  const searchHits = searchOpen ? searchMessages(messages, searchKeyword) : [];
  const currentHit = searchHits.length > 0 ? searchHits[searchIdx % searchHits.length] : null;
  const searchCurIndex = currentHit ? currentHit.index : -1;

  // F-9-2 跳转：滚动到命中消息索引（虚拟列表按索引定位到序）。
  // M8：远端条目未测量前按 estimateSize 估计，scrollToIndex 落点会漂移——
  // 首跳后等两帧（测量已随渲染发生）再校跳一次，长消息场景落点基本准确。
  function jumpToSearch(index: number) {
    logger.info("chat", "search-jump", { index });
    virtualizer.scrollToIndex(index, { align: "start" });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        virtualizer.scrollToIndex(index, { align: "start" });
      }),
    );
  }
  function nextHit(delta: 1 | -1) {
    if (searchHits.length === 0) return;
    const next = (searchIdx + delta + searchHits.length) % searchHits.length;
    setSearchIdx(next);
    jumpToSearch(searchHits[next].index);
  }
  function closeSearch() {
    setSearchOpen(false);
    setSearchKeyword("");
    setSearchIdx(0);
  }
  // M8：搜索条出现时聚焦（原实现焦点留在原地，键盘流断裂）
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  return {
    searchOpen,
    setSearchOpen,
    searchKeyword,
    setSearchKeyword,
    setSearchIdx,
    searchHits,
    searchCurIndex,
    searchIdx,
    nextHit,
    closeSearch,
    searchInputRef,
  };
}
