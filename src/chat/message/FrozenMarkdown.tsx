// P42 前缀冻结：块级 settled/tail 分离渲染。
//
// 问题（bench/streamdown-parse.bench.mjs 实测）：streamdown 每 commit 对全文跑
// remend + Lexer.lex（parseMarkdownIntoBlocks），整个 turn O(n²)。块级 memo 只省
// 「已完成块的 unified parse」，省不掉每帧的全文本重扫。
//
// 方案：沿用 streamdown 自己的 parseMarkdownIntoBlocks（导出 API），把块列表分成
//   - settled：除最后一个块外的全部块 → 内容引用稳定后不再变化，每块独立
//     <Streamdown mode="static">（一次解析后永久 memo 命中，零重扫）；
//   - tail：最后一个块 → 仍走 live streaming 模式（remend/lex 只跑这个块的内容）。
// 全文成本从 O(全文)/帧 降到 O(尾块)/帧。
//
// 关键正确性约束：
//   1. 块切分必须与 streamdown 内部一致——直接用其导出的 parseMarkdownIntoBlocks
//      （_t 实现：Lexer.lex + html/围栏合并），不自己写切分器。
//   2. settled 判定用「块内容字符串引用」而不是块序号：live=false 时尾块晋升为
//      settled，靠 useMemo 缓存 settled 数组，已完成块引用不变 → React.memo 跳过。
//   3. 尾块必须保留「可能是同一段落的后续追加」语义——只有当「最后一个块」在
//      下一帧切分结果里仍是同一前缀的延续时才继续作为 tail；实现上无需显式跟踪：
//      每帧重切后 settled=blocks[0..n-1] 用内容做 key，React 按 key 复用实例，
//      未变的块内容字符串相等（memo 浅比较命中）。
//
// 与 P31 的关系：P31 的 streaming 插件组（无 code）仍用于 tail 块；settled 块
// 用完整插件组（含 code），走 shiki 缓存高亮一次。

import { useMemo, useRef } from "react";
import { Streamdown, parseMarkdownIntoBlocks } from "streamdown";

export interface FreezeRenderOptions {
  /** 完整插件组（块完成后/settled 块用，含 code 高亮） */
  pluginsFull: React.ComponentProps<typeof Streamdown>["plugins"];
  /** 流式插件组（增长尾块用，无 code——P31 止血） */
  pluginsStreaming: React.ComponentProps<typeof Streamdown>["plugins"];
  shikiTheme: React.ComponentProps<typeof Streamdown>["shikiTheme"];
  components?: React.ComponentProps<typeof Streamdown>["components"];
}

export interface FrozenBlocksProps extends FreezeRenderOptions {
  /** 当前文本（流式期间持续追加） */
  text: string;
  /** 是否仍在流式（live=false 时整段走 static 快路径） */
  live: boolean;
}

/**
 * 块级前缀冻结渲染。live=true 时把 text 切块，前 n-1 块以 static 模式渲染
 * （内容不变则 memo 恒命中），最后一块以 streaming 模式渲染；live=false 时
 * 等价于单个 static Streamdown。
 */
export function FrozenMarkdownBlocks({
  text,
  live,
  pluginsFull,
  pluginsStreaming,
  shikiTheme,
  components,
}: FrozenBlocksProps) {
  // 非 live：整段一个 static（块级冻结只在流式期间有意义）
  if (!live) {
    return (
      <Streamdown mode="static" parseIncompleteMarkdown={false} plugins={pluginsFull} shikiTheme={shikiTheme} components={components}>
        {text}
      </Streamdown>
    );
  }
  return <LiveFrozen text={text} pluginsFull={pluginsFull} pluginsStreaming={pluginsStreaming} shikiTheme={shikiTheme} components={components} />;
}

function LiveFrozen({
  text,
  pluginsFull,
  pluginsStreaming,
  shikiTheme,
  components,
}: Omit<FrozenBlocksProps, "live">) {
  // 每帧重切（Lexer.lex 本身 O(n)，但产出的是块字符串数组——重扫只发生在这里，
  // 后续 settled 块靠 memo 零成本跳过；重扫成本远小于 streamdown 内部
  // 「全文 remend + 尾块 unified parse」的叠加）。
  const blocks = useMemo(() => parseMarkdownIntoBlocks(text), [text]);

  // settled 块缓存：内容字符串相同 → 复用同一引用（配合 Streamdown 顶层
  // memo 的 children===children 判定，已完成块整树跳过）。
  const settledCacheRef = useRef(new Map<number, string>());
  const settled = useMemo(() => {
    const cache = settledCacheRef.current;
    const n = blocks.length;
    // 尾块（n-1）在增长中，不进 settled；前面的块若内容与缓存一致则复用。
    const out: string[] = [];
    for (let i = 0; i < n - 1; i++) {
      const b = blocks[i];
      out.push(cache.get(i) === b ? (cache.get(i) as string) : b);
      cache.set(i, b);
    }
    // 块数回退（流式重切导致块合并，如段落续写）时清掉失效缓存项
    if (cache.size > n) {
      for (const k of cache.keys()) if (k >= n - 1) cache.delete(k);
    }
    return out;
  }, [blocks]);

  const tail = blocks.length > 0 ? blocks[blocks.length - 1] : "";
  // 尾块稳定 key：流式期间 tail 内容变但 key 不变 → 不重挂；settled 块 key 含序号。
  // settled 引用稳定（内容相等即同引用）→ Streamdown memo 命中，零重渲染。

  return (
    <>
      {settled.map((content, i) => (
        <Streamdown
          key={`s-${i}`}
          mode="static"
          parseIncompleteMarkdown={false}
          plugins={pluginsFull}
          shikiTheme={shikiTheme}
          components={components}
        >
          {content}
        </Streamdown>
      ))}
      <Streamdown
        key="tail"
        mode="streaming"
        parseIncompleteMarkdown
        plugins={pluginsStreaming}
        shikiTheme={shikiTheme}
        components={components}
      >
        {tail}
      </Streamdown>
    </>
  );
}
