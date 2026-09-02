import { useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { AgentIcon } from "./ui/icons";

/**
 * 头像体系（P7 · F-7-3）：四层降级链。
 *   1. ACP registry CDN SVG（https://cdn.agentclientprotocol.com/registry/<id>.svg）
 *      拉取 → 内联渲染（内联才能随主题变色）；含 currentColor 则用 CSS mask 反色。
 *   2. 本地品牌 SVG 资产（src/assets/agent-logos/<id>.svg）
 *   3. 名称首字母 monogram（品牌色底 + 白字，同 adapter 恒定）
 *   4. lucide Bot 通用图标
 *
 * CDN 不可达时静默降级（内存缓存 + 默认先展示本地/monogram，CDN 命中后升级渲染）。
 * 三档尺寸：size="sm"(16) / "md"(32) / "xs"(14) 由调用方显式传。
 */

export interface AgentAvatarProps {
  /** adapterId，用于 CDN / 本地资产命名 */
  adapterId?: string;
  /** adapter 显示名，用于 monogram 首字母 */
  name?: string;
  /** 品牌色（hex），monogram 底色；缺失用灰 */
  brandColor?: string | null;
  /** 像素尺寸：32（消息流）/ 16（输入框徽标）/ 14（Tab 徽标） */
  size?: number;
  className?: string;
}

const CDN_BASE = "https://cdn.agentclientprotocol.com/registry";

// 已拉取结果内存缓存（SVG 文本 / null=失败，避免重复请求）
const svgCache = new Map<string, string | null>();
// 进行中的请求去重
const inflight = new Map<string, Promise<string | null>>();

function fetchCdnSvg(adapterId: string): Promise<string | null> {
  if (svgCache.has(adapterId)) return Promise.resolve(svgCache.get(adapterId)!);
  const inflightReq = inflight.get(adapterId);
  if (inflightReq) return inflightReq;
  const p = fetch(`${CDN_BASE}/${adapterId}.svg`)
    .then((r) => (r.ok ? r.text() : null))
    .catch(() => null)
    .then((text) => {
      svgCache.set(adapterId, text);
      inflight.delete(adapterId);
      return text;
    });
  inflight.set(adapterId, p);
  return p;
}

/** 本地品牌 SVG：用 Vite 动态 import（命中则返回模块 URL，未命中抛错降级） */
const localSvgCache = new Map<string, string | null>();
async function loadLocalSvg(adapterId: string): Promise<string | null> {
  if (localSvgCache.has(adapterId)) return localSvgCache.get(adapterId)!;
  try {
    const mod = (await import(
      /* @vite-ignore */ `../../assets/agent-logos/${adapterId}.svg`
    )) as { default: string };
    localSvgCache.set(adapterId, mod.default);
    return mod.default;
  } catch {
    localSvgCache.set(adapterId, null);
    return null;
  }
}

/** SVG 含 currentColor → 用 CSS mask 渲染跟随主题文字色（AionUi ThemedLogo 方案） */
function usesCurrentColor(svg: string): boolean {
  return svg.includes("currentColor");
}

function SvgLogo({ svg, size, themed }: { svg: string; size: number; themed: boolean }) {
  if (themed) {
    // CSS mask：单色 logo 跟随主题文字色
    return (
      <span
        role="img"
        aria-label="agent"
        className="inline-block align-middle"
        style={{
          width: size,
          height: size,
          backgroundColor: "var(--text-primary)",
          WebkitMask: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") center/contain no-repeat`,
          mask: `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") center/contain no-repeat`,
        }}
      />
    );
  }
  // 内联 SVG：可随主题自行变色
  return (
    <span
      role="img"
      aria-label="agent"
      className="inline-block align-middle"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function AgentAvatar({
  adapterId,
  name,
  brandColor,
  size = 32,
  className,
}: AgentAvatarProps) {
  const [cdnSvg, setCdnSvg] = useState<string | null>(() =>
    adapterId ? svgCache.get(adapterId) ?? null : null,
  );
  const [localSvg, setLocalSvg] = useState<string | null>(() =>
    adapterId ? localSvgCache.get(adapterId) ?? null : null,
  );
  // 本地加载中标记：默认先展示 monogram，本地 SVG 命中后替换
  const [localLoading, setLocalLoading] = useState(Boolean(adapterId));

  useEffect(() => {
    if (!adapterId) return;
    let alive = true;
    // 优先级 1：CDN → 命中后覆盖本地
    fetchCdnSvg(adapterId).then((svg) => {
      if (alive && svg) setCdnSvg(svg);
    });
    // 优先级 2：本地资产（同步先于 CDN 展示，避免断网无头像）
    loadLocalSvg(adapterId).then((svg) => {
      if (alive) {
        setLocalSvg(svg);
        setLocalLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [adapterId]);

  const ch = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  const bg = brandColor || "#9e9e9e";

  // 优先级 1：CDN SVG（内联，含 currentColor 则 theme 化）
  const svg = cdnSvg ?? localSvg;
  if (svg) {
    return <SvgLogo svg={svg} size={size} themed={usesCurrentColor(svg)} />;
  }
  // 本地仍在加载中（可能断网/无本地资产）→ 先 monogram，加载完成自然替换
  if (!localLoading && localSvg === null) {
    // 本地确认无资产 → 名称首字母 monogram（AC-P7-3-2 颜色稳定）
    return (
      <span
        className={cn("inline-flex items-center justify-center rounded-full font-semibold text-white select-none", className)}
        style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.5) }}
        title={name}
      >
        {ch}
      </span>
    );
  }
  // localLoading 且无 cdn → 先兜底 monogram
  return (
    <span
      className={cn("inline-flex items-center justify-center rounded-full font-semibold text-white select-none", className)}
      style={{ width: size, height: size, background: bg, fontSize: Math.round(size * 0.5) }}
      title={name}
    >
      {ch}
    </span>
  );
}

/** 通用兜底：无 adapterId / 无名称时用 lucide Bot（优先级 4） */
export function BotAvatar({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center justify-center rounded-full text-[var(--text-secondary)]", className)}
      style={{ width: size, height: size }}
      aria-label="agent"
    >
      <AgentIcon style={{ width: Math.round(size * 0.62), height: Math.round(size * 0.62), strokeWidth: 1.75 }} />
    </span>
  );
}
