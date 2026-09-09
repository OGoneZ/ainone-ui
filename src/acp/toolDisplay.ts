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
export function toolSubtitle(rawInput: unknown, title?: string): string | null {
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const input = rawInput as Record<string, unknown>;

  // 命令优先（execute 最常见）；pattern 是搜索的独有字段，需在 path 分支前判定
  if (typeof input.command === "string" && input.command.trim()) {
    return truncate(input.command.replace(/\s+/g, " ").trim());
  }
  // skill 加载（claude-agent-acp：rawInput {skill: "<name>"}）
  // 去重：桥的 title 本就是「Load skill: <name>」（tools.js toolInfoFromToolUse），
  // 副标题再显示一遍 skill 名会重复（用户实测）。title 已含名 → 不出副标题。
  if (typeof input.skill === "string" && input.skill.trim()) {
    const name = input.skill.trim();
    if (title && title.includes(name)) return null;
    return truncate(name);
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

/** P36 R3：写操作工具的「预览文件」目标路径。
 *  优先级：① content 里 diff 的 path（写操作已展开 diff 的场景）；
 *          ② rawInput 的 file_path / path（omp 双字段形，与 toolSubtitle 同款双认）。
 *  kind 参数保留（调用侧语义显式），命中不了（execute/search/fetch 等）→ null。 */
export function previewTargetOf(
  _toolKind: string | undefined | null,
  rawInput: unknown,
  content: Array<{ kind: string; diff?: { path: string } }>,
): string | null {
  for (const c of content) {
    if (c.kind === "diff" && c.diff?.path) return c.diff.path;
  }
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const input = rawInput as Record<string, unknown>;
  const filePath = [input.file_path, input.path].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return filePath ?? null;
}

/** P36 R1：execute 类工具的完整命令原文（两段式展开的命令段数据源）。
 *  与 toolSubtitle 不同——不做截断/空格折叠，保留换行原样。
 *  命中条件（不依赖 kind 准确性，与 toolSubtitle 同纪律）：
 *    kind === "execute"，或 kind 缺省但 rawInput 有非空 command 字段。
 *  命中不了 → null（组件侧整段不渲染）。 */
export function toolCommand(toolKind: string | undefined | null, rawInput: unknown): string | null {
  const isExecute = toolKind === "execute" || toolKind === undefined || toolKind === null;
  if (!isExecute) return null;
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) return null;
  const command = (rawInput as Record<string, unknown>).command;
  if (typeof command !== "string" || !command.trim()) return null;
  return command;
}

/** P36 R1：rawOutput → 兜底输出文本（content 无 text 输出时两段式展开的输出段数据源）。
 *  已知形状（omp 实测）：{content:[{type:"text",text}], details:{…}}——取 content 内 text 拼接；
 *  纯字符串直接用；其他对象 JSON pretty；null/空 → null（不渲染输出段）。 */
export function toolOutputFallback(rawOutput: unknown): string | null {
  if (rawOutput === null || rawOutput === undefined) return null;
  if (typeof rawOutput === "string") return rawOutput.length > 0 ? rawOutput : null;
  if (Array.isArray(rawOutput)) {
    const joined = rawOutput
      .map((item) => {
        if (typeof item === "object" && item !== null) {
          // omp content 元素形状：{type:"text", text}——text 直取；
          // 兼容嵌套 {content:[…]}（递归）
          const rec = item as Record<string, unknown>;
          if (rec.type === "text" && typeof rec.text === "string") return rec.text;
          if (Array.isArray(rec.content)) return toolOutputFallback(rec.content) ?? "";
        }
        return typeof item === "string" ? item : "";
      })
      .join("");
    return joined.length > 0 ? joined : null;
  }
  if (typeof rawOutput === "object") {
    const content = (rawOutput as Record<string, unknown>).content;
    if (Array.isArray(content)) return toolOutputFallback(content);
    try {
      return JSON.stringify(rawOutput, null, 2);
    } catch {
      return String(rawOutput);
    }
  }
  return null;
}

// —— P36 反馈：危险命令识别（rm 等删除类命令 execute 卡红色警示）——
// claude 桥对 rm 命令报 kind=execute（非 delete），纯 kind 分支无危险语义。
// 命令级检测：按顶层控制操作符（&& || ; |）切段（引号/$()/反引号内不分），每段首
// 命令（穿透 env= 前缀 / sudo / env，绝对路径取 basename）命中危险清单 → danger。
// 保守清单起步：文件/目录删除 + 磁盘覆写类。宁可漏报不误报（find -delete、git clean 不收）。
const DANGEROUS_COMMANDS = new Set(["rm", "rmdir", "shred", "unlink", "mkfs", "mkfs.ext4", "mkfs.xfs", "truncate"]);

/** 单段命令的首命令是否危险（env/sudo 穿透 + basename 归一） */
function segmentIsRisky(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  for (const t of tokens) {
    if (t.length === 0) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) continue; // env 赋值前缀
    if (t === "sudo" || t === "env") continue;
    const base = t.split("/").pop() ?? t;
    return DANGEROUS_COMMANDS.has(base);
  }
  return false;
}

/** execute 命令是否具危险语义（渲染层 data-risk="danger" → 红色边框/图标）。
 *  多段命令（bun … && rm …）任意段命中即危险；引号/子命令内不切不判。 */
export function isRiskyCommand(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let subDepth = 0;
  let segStart = 0;
  const segments: string[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (escaped) { escaped = false; i += 1; continue; }
    if (ch === "\\") { escaped = true; i += 1; continue; }
    if (inSingle) { if (ch === "'") inSingle = false; i += 1; continue; }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "$" && command[i + 1] === "(") subDepth += 1;
      i += 1;
      continue;
    }
    if (ch === "'") { inSingle = true; i += 1; continue; }
    if (ch === '"') { inDouble = true; i += 1; continue; }
    if (ch === "$" && command[i + 1] === "(") { subDepth += 1; i += 2; continue; }
    if (ch === ")") { if (subDepth > 0) subDepth -= 1; i += 1; continue; }
    if (subDepth === 0) {
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||" || ch === ";" || ch === "|") {
        segments.push(command.slice(segStart, i));
        i += two.length === 2 ? 2 : 1;
        segStart = i;
        continue;
      }
    }
    i += 1;
  }
  segments.push(command.slice(segStart));
  return segments.some(segmentIsRisky);
}
