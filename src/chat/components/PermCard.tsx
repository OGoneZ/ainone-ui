// F-21-4 权限审批内嵌卡：agent 的 requestPermission 请求渲染为会话窗格内的
// 可交互卡片（替代 P7 的全屏 modal Dialog——多分屏时遮挡其他窗格且看不出
// 是哪个 session 在申请）。AskCard 同款模式：受控组件 + 按钮组回传决策。
//
// 按钮按 harness 给的 options 全量渲染（optionId 直传，不再客户端猜 allow/reject
// 前缀——L12 的 kind 匹配随全屏 Dialog 一并废弃）。kind 用于视觉分级：
// allow_* 主按钮实底、reject_* 描边、其余中性。

import { Button } from "@/components/ui/button";
import { logger } from "@/lib/logger";

/** 权限选项（ACP PermissionOption 投影，store 里落这份，不存 SDK 对象） */
export interface PermOption {
  optionId: string;
  name: string;
  kind: string | null;
}

interface Props {
  /** 工具调用标题（申请的是什么操作） */
  title: string;
  options: PermOption[];
  /** 决策回传：ACP optionId 原样回传（ChatPanel 按 optionId 找回选项构造响应） */
  onDecide: (optionId: string) => void;
}

export function PermCard({ title, options, onDecide }: Props) {
  function decide(optionId: string, name: string) {
    logger.info("chat", "perm-decide", { optionId, name });
    onDecide(optionId);
  }

  return (
    <div className="perm-card" data-testid="perm-card">
      <div className="perm-card-title">⚠️ 需要批准执行</div>
      <p className="perm-code">
        <code>{title}</code>
      </p>
      <div className="perm-card-actions">
        {options.map((o) => {
          const allow = o.kind?.startsWith("allow") ?? false;
          const reject = o.kind?.startsWith("reject") ?? false;
          return (
            <Button
              key={o.optionId}
              variant={allow ? "default" : reject ? "outline" : "secondary"}
              onClick={() => decide(o.optionId, o.name)}
            >
              {o.name}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
