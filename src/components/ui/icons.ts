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
  Activity,
  ArchiveRestore,
  ArrowRight,
  ArrowUp,
  BellRing,
  Bot,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock,
  Coffee,
  Copy,
  ArrowLeftRight,
  FileDiff,
  FileText,
  Folder,
  FolderOpen,
  FolderSymlink,
  GitFork,
  Globe,
  GripVertical,
  Eye,
  Loader2,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Mic,
  Minimize2,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  ScrollText,
  Search,
  Settings,
  Square,
  SquareTerminal,
  Sun,
  Terminal,
  Trash2,
  CircleHelp,
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
export const NewTerminalIcon = SquareTerminal; // P25 新建终端入口（侧栏头部图标钮）
// P30：ToolKind 图标（toolDisplay.kindIcon 消费；read 复用 FileTextIcon / think 复用 ThinkingIcon）
export const EditIconKind = Pencil; // kind=edit
export const DeleteIcon = Trash2; // kind=delete
export const MoveIcon = FolderSymlink; // kind=move
export const SearchIcon = Search; // kind=search
export const FetchIcon = Globe; // kind=fetch
export const SwitchModeIcon = Repeat; // kind=switch_mode
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
export const SwitchIcon = ArrowLeftRight; // P29 模型/URL 切换入口
export const RestoreIcon = ArchiveRestore; // P30 回收站「恢复」按钮（箱中取出向上箭头）

// 通用符号
export const ChevronDownIcon = ChevronDown;
export const ChevronRightIcon = ChevronRight;
export const RateIcon = Activity; // P37：输出速率（心电波形，与线宽体系一致）
export const CloseIcon = X;
export const PlusIcon = Plus;
export const CheckIcon = Check;
export const GripVerticalIcon = GripVertical; // 拖拽手柄
export const EditIcon = Pencil; // F-12-1 编辑重试
export const CommentIcon = MessageSquarePlus; // F-12-5 diff 行内评论
export const ForkIcon = GitFork; // F-15-4 分叉（icon-only 化）
export const RewindIcon = Undo2; // F-15-4 回溯（icon-only 化）
export const ClockIcon = Clock; // turn 总耗时计时
export const EyeIcon = Eye; // P36 R3 工具卡「预览文件」入口
export const MicIcon = Mic; // F-15-5 语音输入（去 emoji）
export const SidebarCollapseIcon = PanelLeftClose; // F-15-7 左侧栏收缩
export const SidebarExpandIcon = PanelLeftOpen; // F-15-7 左侧栏展开
export const ExpandIcon = Maximize2; // F-18-2 输入框全屏编辑
export const ShrinkIcon = Minimize2; // F-18-2 退出全屏编辑
export const DonateIcon = Coffee; // P22 打赏作者入口
export const HelpIcon = CircleHelp; // P25 快捷键帮助入口
export const WebsiteIcon = Globe; // P38 官网入口
export const ChangelogIcon = ScrollText; // P38 更新日志入口
export const RefreshIcon = RefreshCw; // P38 检查更新（重新刷新语义）
export const ThemeAutoIcon = Monitor; // 主题·跟随系统
export const ThemeLightIcon = Sun; // 主题·浅色
export const ThemeDarkIcon = Moon; // 主题·深色
