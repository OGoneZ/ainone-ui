// 欢迎页：问候语 + 建议 prompt（F-6-3 / F-7-6）。自 ChatPanel 拆出（P13 C3）。

import { welcomeGreeting, suggestionsFor } from "@/chat/logic/welcome";
import { ArrowRightIcon } from "@/components/ui/icons";
import type { AdapterWithStatus } from "@/ipc/adapters";

export function Welcome({ adapter, onSuggest }: { adapter: AdapterWithStatus; onSuggest: (t: string) => void }) {
  const greeting = welcomeGreeting(new Date().getHours());
  const suggestions = suggestionsFor(adapter);
  return (
    <div className="welcome">
      <h2>{greeting}！我可以帮你做什么？</h2>
      <div className="suggestions">
        {suggestions.map((s) => (
          <button key={s} className="suggestion group inline-flex items-center gap-1" onClick={() => onSuggest(s)}>
            <span>{s}</span>
            {/* F-7-6 AC-P7-6-3：hover 箭头从左滑入 */}
            <ArrowRightIcon
              className="opacity-0 -translate-x-1 transition-all group-hover:opacity-100 group-hover:translate-x-0"
              style={{ width: 14, height: 14, strokeWidth: 1.75, transitionDuration: "var(--motion-fast)" }}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
