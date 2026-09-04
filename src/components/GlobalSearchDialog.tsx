// 全局 session 搜索弹层（P11 · F-11-2，Ctrl/Cmd+F 悬浮中上，DEC-26）。
//
// shadcn CommandDialog（cmdk，自带键盘导航 + 滚动跟随）；数据源 sessions_list，
// fuzzy 过滤（DEC-25）；回车/点击 → resolveHistoryOpen 打开/激活 Tab。
// 由 App 挂载（拥有 openSession 回调），本组件只管弹层与选中回调。

import { useEffect, useState } from "react";
import { CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "./ui/command";
import { AgentAvatar } from "./AgentAvatar";
import { sessionsList, type SessionEntry } from "../ipc/sessions";
import { filterSessions, relativeTime, type SearchableSession } from "../chat/logic/globalSearch";
import { logger } from "../lib/logger";

import { listAdapters, type AdapterWithStatus } from "../ipc/adapters";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 选中某会话 → App 用 resolveHistoryOpen 打开/激活 */
  onPick: (entry: SessionEntry) => void;
}

/** 取 cwd 尾段 */
function tailOf(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function GlobalSearchDialog({ open, onOpenChange, onPick }: Props) {
  const [entries, setEntries] = useState<SearchableSession[]>([]);
  const [adapters, setAdapters] = useState<AdapterWithStatus[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    logger.info("search", "global-open", {});
    sessionsList().then(setEntries).catch(() => {});
    listAdapters().then(setAdapters).catch(() => {});
  }, [open]);

  const hits = filterSessions(entries, query);
  const adapterById = new Map(adapters.map((a) => [a.id, a]));

  function pick(entry: SearchableSession) {
    logger.info("search", "global-jump", { sessionId: entry.session_id });
    onOpenChange(false);
    onPick(entry as SessionEntry);
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => {
        if (!v) logger.info("search", "global-close", {});
        onOpenChange(v);
      }}
      className="global-search-dialog"
      title="搜索会话"
      description="按标题或目录模糊搜索会话"
    >
      <CommandInput
        placeholder="搜索会话…（标题 / 目录，模糊匹配）"
        value={query}
        onValueChange={(v) => {
          setQuery(v);
          logger.debug("search", "global-filter", { query: v, hits: hits.length });
        }}
      />
      <CommandList>
        <CommandEmpty>无匹配会话</CommandEmpty>
        <CommandGroup heading={query.trim() ? `匹配 ${hits.length} 条` : "最近会话"}>
          {hits.map((e) => {
            const ad = adapterById.get(e.adapter_id);
            return (
              <CommandItem key={e.session_id} value={`${e.title} ${e.cwd} ${e.session_id}`} onSelect={() => pick(e)}>
                <AgentAvatar adapterId={ad?.id} name={ad?.name} brandColor={ad?.logo ?? null} size={16} className="shrink-0" />
                <span className="gs-title">{e.title}</span>
                <span className="gs-cwd">{tailOf(e.cwd)}</span>
                <span className="gs-time">{relativeTime(e.mtime_ms)}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
