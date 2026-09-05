// 图标体系（P7 · F-7-9）：lucide-react 的语义映射，全仓唯一入口。
//
// 纪律（AC-P7-9-1 / AC-P7-9-3）：
//   - 组件禁用 `import { ... } from "lucide-react"` 散用，一律从此文件取。
//   - 尺寸五档 12/14/16/20/24（size prop 强约束），线宽统一 1.75。
//   - 未来换图标库只改这一处。
//
// 命名：语义名 + `Icon` 后缀；「状态机」与「语义」一一对应（见 plan-p7-ui.md §F-7-9）。
// 注：lucide 已把 CheckCircle2 更名为 CircleCheck，此处按语义导出，映射表仍成立。

import {
  ArrowRight,
  ArrowUp,
  BellRing,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Copy,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  GitFork,
  GripVertical,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  Pencil,
  Plus,
  Settings,
  Square,
  Terminal,
  Undo2,
  User,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";

export type { LucideIcon };

// 语义映射（与 plan-p7-ui.md §F-7-9 表对应）
export const AgentIcon = Bot; // agent 头像兜底
export const ThinkingIcon = Brain; // thinking 块
export const ToolIcon = Wrench; // 工具调用
export const TerminalIcon = Terminal; // 终端输出
export const FileTextIcon = FileText; // 文件
export const DiffIcon = FileDiff; // diff 视图
export const CopyIcon = Copy; // 复制
export const WorkspaceIcon = Folder; // 工作区（收拢）
export const WorkspaceOpenIcon = FolderOpen; // 工作区（展开）
export const SessionIcon = MessageSquare; // 会话
export const WorkingIcon = Loader2; // 状态 working（旋转）
export const AwaitingIcon = BellRing; // 状态 awaiting_input（wiggle）
export const DoneIcon = CircleCheck; // 状态 done
export const UserIcon = User; // 用户
export const SettingsIcon = Settings; // 设置
export const SendIcon = ArrowUp; // 发送
export const StopIcon = Square; // 停止
export const ArrowRightIcon = ArrowRight; // 建议 prompt hover 箭头

// 通用符号
export const ChevronDownIcon = ChevronDown;
export const ChevronRightIcon = ChevronRight;
export const CloseIcon = X;
export const PlusIcon = Plus;
export const CheckIcon = Check;
export const GripVerticalIcon = GripVertical; // 拖拽手柄
export const EditIcon = Pencil; // F-12-1 编辑重试
export const CommentIcon = MessageSquarePlus; // F-12-5 diff 行内评论
export const ForkIcon = GitFork; // F-15-4 分叉（icon-only 化）
export const RewindIcon = Undo2; // F-15-4 回溯（icon-only 化）
export const MicIcon = Mic; // F-15-5 语音输入（去 emoji）
