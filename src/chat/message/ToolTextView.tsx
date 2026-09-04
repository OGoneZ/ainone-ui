// 工具文本渲染（P11 F-R6）：JSON pretty / ANSI 彩色 / 纯文本三分支 + 超长折叠。
// 自 ChatPanel 拆出（P13 C3）。导出供测试。

import { useMemo, useState } from "react";
// ansi-to-react 是 CJS 单导出（exports.default），ESM interop 后需再取一层 default
import AnsiPkg from "ansi-to-react";
import { prettyJson } from "@/acp/toolFormat";

const Ansi = (AnsiPkg as unknown as { default?: typeof AnsiPkg }).default ?? AnsiPkg;

/** P11 F-R6：工具 text 内容渲染——JSON pretty / ANSI 彩色 / 纯文本三分支，
 *  超长输出默认折叠（AC-R6-1..4）。导出供测试。 */
export const TOOL_TEXT_FOLD_LIMIT = 2000;

export function ToolTextView({ text }: { text: string }) {
  const foldable = text.length > TOOL_TEXT_FOLD_LIMIT;
  const [expanded, setExpanded] = useState(false);
  // 折叠态截断渲染（ansi-to-react 与 JSON.stringify 对超长文本都慢，先截断再处理）。
  // M10：截断要同时作用于 JSON 分支——原实现 pretty 用全量原文、截断只影响
  // ANSI 路径，折叠按钮点了没效果，超大 JSON 直接冻结面板。
  const shown = foldable && !expanded ? text.slice(0, TOOL_TEXT_FOLD_LIMIT) : text;
  const pretty = useMemo(() => (expanded ? prettyJson(text) : prettyJson(shown)), [shown, text, expanded]);
  const body =
    pretty !== null ? (
      <pre className="tool-text">
        <code>{pretty}</code>
      </pre>
    ) : (
      <AnsiView text={shown} />
    );
  return (
    <div className="tool-text-view">
      {body}
      {foldable && (
        <button
          type="button"
          className="tool-text-fold"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : `展开全部（${text.length} 字符）`}
        </button>
      )}
    </div>
  );
}

/** ANSI 转义渲染（DEC-23：ansi-to-react）；无 ANSI 码时原样文本 */
function AnsiView({ text }: { text: string }) {
  // ansi-to-react 仅在含转义序列时产生彩色 span，否则整段直出——这里直接交给它
  return (
    <pre className="tool-text">
      <Ansi>{text}</Ansi>
    </pre>
  );
}
