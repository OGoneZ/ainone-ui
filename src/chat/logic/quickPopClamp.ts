// P35 R1：快问悬浮窗视口自适应定位（纯函数 + 测试）。
//
// anchor 取自鼠标位置（.chat 内容区坐标），悬浮窗实测尺寸渲染后才可得。
// clampQuickAnchor 把「期望锚点 + 实测尺寸 + 容器尺寸」收敛为不越界锚点：
//   右溢出 → 左移（贴右缘 MARGIN）；下溢出 → 上移（贴下缘 MARGIN）；
//   结果再 clamp 到 [MARGIN, 容器-尺寸-MARGIN] 下限，窄容器（< 尺寸+2×MARGIN）
//   时贴 MARGIN 让 CSS max-width 兜底。
// 悬浮窗 absolute 定位祖先 = .chat（position:relative 由样式层保证），
// 尺寸语义全部是容器内坐标，与 H6 坐标换算同一参照系。

export const QUICK_POP_MARGIN = 8;

/** 视口自适应：返回修正后的 {x,y}（容器内坐标）。
 *  popSize 实测悬浮窗尺寸（挂载后 measureElement / getBoundingClientRect）；
 *  containerSize 容器（.chat）可视尺寸（getBoundingClientRect，不含滚动外溢）。 */
export function clampQuickAnchor(
  anchor: { x: number; y: number },
  popSize: { width: number; height: number },
  containerSize: { width: number; height: number },
  margin: number = QUICK_POP_MARGIN,
): { x: number; y: number } {
  const maxX = Math.max(margin, containerSize.width - popSize.width - margin);
  const maxY = Math.max(margin, containerSize.height - popSize.height - margin);
  return {
    x: Math.min(Math.max(anchor.x, margin), maxX),
    y: Math.min(Math.max(anchor.y, margin), maxY),
  };
}
