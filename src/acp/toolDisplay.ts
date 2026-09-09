// P30 工具显示细化纯函数：kind → 图标/文案映射，rawInput → 参数副标题提炼。
// 零 React 依赖（icons.ts 的映射表是 LucideIcon 常量引用，不触发 React 渲染）。
//
// 设计要点：
//   - toolSubtitle 不依赖 kind 的准确性（桥可能不报 kind），直接认 rawInput 字段名
//     （command/file_path/path/pattern/url/prompt），都命中不了 → null 不显示。
//   - 未知形状（数组/标量/null）一律安全返回 null，绝不抛错（渲染层兜底纪律）。
//   - 副标题超长截断（80 字符），全路径信息保留在 title 属性（组件侧职责）。

import type { LucideIcon } from "@/components/ui/icons";
import {
  DeleteIcon,
  EditIconKind,
  FetchIcon,
  FileTextIcon,
  MoveIcon,
  SearchIcon,
  SwitchModeIcon,
  TerminalIcon,
  ThinkingIcon,
  ToolIcon,
} from "@/components/ui/icons";

/** 协议 ToolKind（read/edit/delete/move/search/execute/think/fetch/switch_mode/other）→ 图标 */
export function kindIcon(kind: string | undefined | null): LucideIcon {
  switch (kind) {
    case "read":
      return FileTextIcon;
    case "edit":
      return EditIconKind;
    case "delete":
      return DeleteIcon;
    case "move":
      return MoveIcon;
    case "search":
      return SearchIcon;
    case "execute":
      return TerminalIcon;
    case "think":
      return ThinkingIcon;
    case "fetch":
      return FetchIcon;
    case "switch_mode":
      return SwitchModeIcon;
    default: // other / 未声明（旧日志）→ 通用扳手
      return ToolIcon;
  }
}

/** ToolKind → 中文标签（活动组摘要/无 title 场景备用；本期 ToolBlock 以 title 为主） */
export function kindLabel(kind: string | undefined | null): string {
  switch (kind) {
    case "read":
      return "读取";
    case "edit":
      return "编辑";
    case "delete":
      return "删除";
    case "move":
      return "移动";
    case "search":
      return "搜索";
    case "execute":
      return "执行";
    case "think":
      return "思考";
    case "fetch":
      return "获取";
    case "switch_mode":
      return "切换模式";
    default:
      return "工具";
  }
}

/** 副标题截断上限 */
const SUBTITLE_LIMIT = 80;

function truncate(s: string): string {
  return s.length > SUBTITLE_LIMIT ? `${s.slice(0, SUBTITLE_LIMIT)}…` : s;
}

/** 路径 → 文件名（末段）；空串安全 */
function basename(p: string): string {
  const segs = p.split("/").filter(Boolean);
  return segs.length ? segs[segs.length - 1] : p;
}

/**
 * 从 rawInput 提关键参数做副标题；命中不了返回 null。
 * 字段名参考主流桥的真实透传（P0 报文 + 今日会话 JSONL 双源）：
 *   Bash→{command}；Read/Write/Edit→{file_path|path}；Glob/Grep→{pattern, path|glob}；
 *   WebFetch→{url}；Agent/Task→{prompt}；Skill→{skill}（claude-agent-acp）
 */
export function toolSubtitle(rawInput: unknown): string | null {
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const input = rawInput as Record<string, unknown>;

  // 命令优先（execute 最常见）；pattern 是搜索的独有字段，需在 path 分支前判定
  if (typeof input.command === "string" && input.command.trim()) {
    return truncate(input.command.replace(/\s+/g, " ").trim());
  }
  // skill 加载（claude-agent-acp：rawInput {skill: "<name>"}）
  if (typeof input.skill === "string" && input.skill.trim()) {
    return truncate(input.skill.trim());
  }
  // 搜索模式（含 in path/glob 后缀）——先于文件路径分支（pattern+path 常同现）
  if (typeof input.pattern === "string" && input.pattern.trim()) {
    const scope = [input.path, input.glob].find((v): v is string => typeof v === "string" && v.trim().length > 0);
    return truncate(`"${input.pattern.trim()}"${scope ? ` in ${scope}` : ""}`);
  }
  // 文件路径 → 文件名
  const filePath = [input.file_path, input.path].find((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (filePath) return basename(filePath);
  // URL
  if (typeof input.url === "string" && input.url.trim()) return truncate(input.url.trim());
  // 子代理任务描述
  if (typeof input.prompt === "string" && input.prompt.trim()) {
    return truncate(input.prompt.replace(/\s+/g, " ").trim());
  }
  return null;
}
