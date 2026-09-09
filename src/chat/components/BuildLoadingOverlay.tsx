import { ClockIcon } from "@/components/ui/icons";

// P38 R4：建链加载悬浮层——窗格中央 + 半透明遮罩。
//
// 触发：ensureSession 建链全程（首条消息 / fork 点击 / 空闲回收重建），starting
// 状态驱动。耗时主体是 harness 侧初始化与历史回放（实测 claude load ~1.5s、
// omp new ~0.4s、spawn+init ~0.2-0.5s），文案用「唤醒」口径。
//
// 定位：挂 ChatPanel 根 .panel（position: relative）下 absolute inset-0——
// 分屏时只覆盖本窗格，其他窗格零感知（FilePreview 浮层同模式，P16 DEC-48）。
// 遮罩阻断交互 = 建链期不接受的输入天然被挡住。
//
// 文案（P38 规格书定稿，两段按场景切换）：
//   恢复历史会话（resumeId 存在）→「正在唤醒这段对话的记忆」
//   新会话 →「正在唤醒 {adapter.name}」
// reduced-motion：跳动动画禁用（三点静止），文字承担全部信息。

export function BuildLoadingOverlay({
  resume,
  adapterName,
}: {
  /** 恢复历史会话（resumeId 存在）→ true；新会话 → false */
  resume: boolean;
  adapterName: string;
}) {
  const title = resume ? "正在唤醒这段对话的记忆" : `正在唤醒 ${adapterName}`;
  const subtitle = resume ? "回放历史消息 · 约 1~2 秒" : "启动 agent · 首次需要一点时间";
  return (
    <div
      className="build-overlay"
      data-testid="build-overlay"
      data-resume={resume ? "true" : "false"}
      role="status"
      aria-live="polite"
    >
      <div className="build-overlay-card">
        <ClockIcon className="build-overlay-icon" style={{ width: 22, height: 22, strokeWidth: 1.75 }} />
        <div className="build-overlay-title">{title}</div>
        <div className="build-overlay-subtitle">{subtitle}</div>
        <div className="build-overlay-dots" aria-hidden="true">
          <span className="build-overlay-dot" />
          <span className="build-overlay-dot" />
          <span className="build-overlay-dot" />
        </div>
      </div>
    </div>
  );
}
