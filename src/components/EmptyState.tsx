// 空状态插画（F-7-12 AC-P7-12-2）：lucide 图标 + 一行文案 + 主行动按钮。
// 用于会话历史为空 / 工作区为空时的空状态。

import type { LucideIcon } from "./ui/icons";
import { SessionIcon } from "./ui/icons";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function EmptyState({
  icon: Icon = SessionIcon,
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 px-4 text-center">
      <Icon
        style={{
          width: 32,
          height: 32,
          strokeWidth: 1.75,
          color: "var(--text-disabled)",
        }}
      />
      <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{title}</div>
      {description && (
        <div style={{ color: "var(--text-disabled)", fontSize: 12 }}>{description}</div>
      )}
      {actionLabel && onAction && (
        <button
          className="mt-1 inline-flex items-center gap-1.5 rounded-full px-4 py-1.5 text-sm"
          style={{
            backgroundColor: "var(--primary)",
            color: "var(--primary-foreground)",
            transitionDuration: "var(--motion-fast)",
          }}
          onClick={onAction}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
