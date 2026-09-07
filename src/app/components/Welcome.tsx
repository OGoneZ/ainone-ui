// 欢迎页（空态）：无任何 tab（无 session / 无终端）时铺满主内容区。
// 内容：透明底主 logo（K1 图形，去 favicon 的米色底块）+ 主标语 + 两行快捷键。
// 标语与门户网站同源（ainone-website site.ts headline）；
// 快捷键文案走 keymap 键位表 formatBinding——用户改绑后欢迎页跟随真实键位。
// 动效（P30）：logo 悬浮呼吸 + 橙格扫视眨眼 + 气泡尾摆动；宣传语打字机（打完停住 + 光标闪）。
// 图形 path 与 favicon.svg 逐字一致不动，动效只做 transform/opacity；
// prefers-reduced-motion 下全部静置（app.css 欢迎页动效块统一降级）。

import { useKeymapStore } from "@/store/keymapStore";
import { formatBinding } from "@/app/logic/keymap";
import { useHeadlineTypewriter } from "@/app/logic/useHeadlineTypewriter";

/** K1 logo 图形（与 public/favicon.svg 逐字一致，仅去掉米色圆角底 rect → 透明背景）。
 * 各部位 class 仅供动效挂载（见 app.css 欢迎页动效块），不影响图形本身。 */
export function LogoMark({ size = 96 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" className="welcome-logo">
      <rect className="welcome-logo-shadow" x="166" y="178" width="284" height="240" rx="56" fill="#E0DBCE" />
      <rect className="welcome-logo-shadow2" x="140" y="146" width="284" height="240" rx="56" fill="#CBC5B7" />
      <g className="welcome-logo-ink" fill="#141414">
        <path transform="translate(114,112)" d="M44 0 H122 A10 10 0 0 1 132 10 V100 A10 10 0 0 1 122 110 H10 A10 10 0 0 1 0 100 V44 A44 44 0 0 1 44 0 Z" />
        <g className="welcome-logo-eye"><g className="welcome-logo-lid"><path transform="translate(256,112)" fill="#D97757" d="M10 0 H98 A44 44 0 0 1 142 44 V110 A10 10 0 0 1 132 120 H10 A10 10 0 0 1 0 110 V10 A10 10 0 0 1 10 0 Z" /></g></g>
        <path transform="translate(114,242)" d="M10 0 H122 A10 10 0 0 1 132 10 V100 A10 10 0 0 1 122 110 H44 A44 44 0 0 1 0 66 V10 A10 10 0 0 1 10 0 Z" />
        <path transform="translate(266,242)" d="M10 0 H122 A10 10 0 0 1 132 10 V66 A44 44 0 0 1 88 110 H10 A10 10 0 0 1 0 100 V10 A10 10 0 0 1 10 0 Z" />
        <path className="welcome-logo-tail" d="M170 352 Q136 398 128 428 Q176 412 222 352 Z" />
      </g>
    </svg>
  );
}

function ShortcutHint({ shortcutId, action }: { shortcutId: "app.new-session" | "app.new-terminal"; action: string }) {
  const bindings = useKeymapStore((s) => s.bindingsOf(shortcutId));
  return (
    <div className="welcome-hint">
      <kbd>{bindings[0] ? formatBinding(bindings[0]) : "—"}</kbd>
      <span>{action}</span>
    </div>
  );
}

export function Welcome() {
  const headline = useHeadlineTypewriter("一个窗口，驱动所有 AI Agent");
  return (
    <div className="welcome-empty">
      <div className="welcome-logo-row">
        <LogoMark />
        <div className="welcome-brand">
          <span className="welcome-brand-name">ainone</span>
          <span className="welcome-brand-sub">Agent in One</span>
        </div>
      </div>
      <h1 className="welcome-headline">
        {headline}
        <span className="welcome-headline-cursor" aria-hidden="true" />
      </h1>
      <p className="welcome-question">今天做些什么?</p>
      <div className="welcome-hints">
        <ShortcutHint shortcutId="app.new-session" action="新建 session" />
        <ShortcutHint shortcutId="app.new-terminal" action="新建终端" />
      </div>
    </div>
  );
}
