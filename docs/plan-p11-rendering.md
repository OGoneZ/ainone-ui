# ainone-ui · P11 LLM 回复渲染增强 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-03
**状态**：已批准基线（调研 + 选型 + 测试/日志要求齐备）
**上游关系**：承接 `docs/plan-p7-ui.md`（设计令牌）、`docs/plan-p8.md` / `docs/plan-p9.md`（消息流 / 搜索 / 批注已就绪）

---

## 0. 目标与非目标

**目标**：让 agent 回复的渲染达到主流社区客户端（Open WebUI / LobeChat / Cherry Studio / Vercel AI Elements）的观感与健壮性基线——完整排版、强代码块、Mermaid、数学公式、图片预览、工具输出可读化、流式不卡。

**非目标（明确排除）**：
- 不渲染 LLM 输出的 raw HTML（维持 react-markdown 默认转义行为，与 Streamdown 安全基线一致）。
- 不做代码执行沙箱（Code Interpreter）、不做 Artifacts 预览面板。
- 不做 diff 库替换现有 DiffView（F-8 产物已够用，本期内不动）。

---

## 1. 调研结论（2026-09-03 社区方案对照）

| 能力 | Open WebUI | LobeChat | Cherry Studio | Vercel Streamdown | 本仓库现状 |
| --- | --- | --- | --- | --- | --- |
| 完整排版（标题/链接/hr/task list） | ✅ | ✅ | ✅ | ✅ | ❌ 半套（无 h1-h6/a/img/hr 样式） |
| 代码高亮 | ✅ | ✅ Shiki | ✅ | ✅ Shiki | ✅ highlight.js（github 主题手写双覆盖） |
| 代码块交互（语言标签/换行切换/复制） | ✅ | ✅ | ✅ | ✅ | 仅复制 |
| Mermaid | ✅ | ✅ | ✅ | ✅ 插件 | ❌ |
| 数学公式 KaTeX | ✅ | ✅ | ✅ | ✅ 插件 | ❌ |
| 流式不完整块兜底（remend） | ✅ | ✅ | ✅ | ✅ 核心特性 | ❌ |
| 流式 memo 优化 | ✅ | ✅ | ✅ | ✅ | ❌ 每 chunk 全文重解析 |
| HTML 安全加固 | ✅ | ✅ | ✅ | ✅ rehype-harden | 默认转义 |
| 图片 lightbox | ✅ | ✅ | ✅ | — | ❌ |
| 工具输出 ANSI 色 | ✅ | ✅ | ✅ | — | ❌ 裸 pre |

**结论**：社区在「渲染层」已收敛为事实标准方案。Vercel Streamdown 是 2025-2026 新出的、专为 AI 流式设计的 react-markdown 替代品（AI Elements 的底层），一举覆盖本仓库 6 个缺口，且明确声明是 drop-in replacement。

---

## 2. 架构决策（DEC）

- **DEC-21**：渲染主组件从手拼 `ReactMarkdown + remarkGfm + rehypeHighlight` 切换为 **Streamdown**（streamdown@2.6.0 + @streamdown/code + @streamdown/mermaid + @streamdown/math）。理由：
  1. 一举覆盖代码块增强、Mermaid、KaTeX、不完整块兜底、内部 memo 五项需求，不重复造轮子（符合仓库金标准：成熟社区库优先）；
  2. Vercel 官方维护、AI Elements 生产验证、React 19 peer 兼容；
  3. 样式经 `data-streamdown` 属性 + 现有设计令牌（`--bg-2`/`--border` 等）对接，不引入第二套主题系统。
  - 代价：放弃 rehype-highlight（highlight.js），换 Shiki（按需懒加载语言，体积可接受；20MB 级非硬红线）。
- **DEC-22**：**deep-dark 主题对接**走 `data-streamdown` 属性选择器 + `:root[data-theme="dark"]` 覆盖，不用 Tailwind `dark:` 前缀（与现有 `@custom-variant dark` 机制对齐）。
- **DEC-23**：工具输出格式化 = **ansi-to-react**（10M+ 下载、Jupyter 生态维护、React 19 peer 兼容）渲染 ANSI 转义；JSON 判定/pretty 化用纯函数自写（20 行内，不值得引依赖）。
- **DEC-24**：图片 lightbox = **react-photo-view**（1.2.7，无样式依赖、支持缩放/手势，中文社区成熟）。触发点仅限 `.md` 内 `img`。
- **DEC-25**：thinking 展开体从纯文本升级为 Streamdown **静态模式**（模型 thinking 同样可能含代码/公式），字号沿用现有 13px 小字。
- **DEC-26**：流式性能 = `React.memo(MessageLine)` + block 引用隔离（store 已保证非末条 block 引用不变），不引 react-window 类重写虚拟列表（现有 @tanstack/react-virtual 保留）。

---

## 3. 依赖变更清单

**新增**：
- `streamdown@^2.6.0`（含 remend、rehype-harden、rehype-sanitize 传递依赖）
- `@streamdown/code@^1.1.1`（Shiki 高亮 + 复制按钮）
- `@streamdown/mermaid@^1.0.2`
- `@streamdown/math@^1.0.2`（KaTeX；需引 `katex/dist/katex.min.css`）
- `ansi-to-react@^6.2.6`
- `react-photo-view@^1.2.7`（+ `react-photo-view/dist/react-photo-view.css`）

**移除**：
- `rehype-highlight`、`highlight.js`（index.css 第 269-358 行 hljs 覆盖段与 CodeBlock 旧样式段一并清理）

**CSS 声明**：`src/index.css` 增加 `@source "../node_modules/streamdown/dist/**/*.js";` 及各插件同款指令（Tailwind v4 需要扫描其类名）。

---

## 4. 功能项（目标 + 验收标准）

> 每项：**G**（目标）→ **AC**（验收标准，编号 AC-R*，供验收记录引用）→ **T**（测试要求）→ **L**（日志要求）。

### F-R1 消息渲染切换 Streamdown（含不完整块兜底）
- **G**：`BlockView` text 分支由 `ReactMarkdown` 换为 `Streamdown`（plugins: code/math/mermaid），历史消息静态、流式末块走 streaming 解析。
- **AC**：
  - AC-R1-1：GFM（表格/任务列表/删除线）与标题/链接正常渲染；
  - AC-R1-2：流式中途文本含未闭合 ```` ``` ````、未闭合 `**`、未闭合链接时，不渲染出破碎节点；
  - AC-R1-3：批注（F-8-2）/ 快问（F-8-7）的选区监听在 Streamdown 容器上继续工作；
  - AC-R1-4：LLM 输出 raw HTML 仍不执行（脚本注入样例渲染为纯文本）。
- **T**：vitest 组件测试 — 不完整块样例流式渲染断言；raw HTML 转义断言。
- **L**：logger.debug `render.streamdown` 首次挂载记录一次（插件清单）。

### F-R2 代码块增强
- **G**：代码块具备语言标签、一键复制、双主题跟随、横向滚动。
- **AC**：
  - AC-R2-1：带 `lang` 围栏渲染出语言标签（小写徽章）；
  - AC-R2-2：复制按钮可见可点，复制内容与源码一致（toast 反馈保留现有 sonner）；
  - AC-R2-3：浅色/深色下高亮均正确（@streamdown/code 双主题）；
  - AC-R2-4：超宽代码横向滚动不撑破气泡。
- **T**：vitest — 代码块渲染语言标签存在 + 复制按钮存在。
- **L**：无新增。

### F-R3 Mermaid 图渲染
- **G**：` ```mermaid ` 围栏渲染为交互式 SVG 图。
- **AC**：
  - AC-R3-1：合法 mermaid 源渲染出 SVG（flowchart 样例）；
  - AC-R3-2：非法 mermaid 源不崩溃，展示错误占位 + 可复制源码；
  - AC-R3-3：流式中的 mermaid 块在源码未闭合时只显示代码不渲染图（不完整块兜底天然满足）；
  - AC-R3-4：虚拟列表中该消息高度正确（动态测量不跳变）。
- **T**：vitest — mock mermaid 渲染为占位节点断言结构（jsdom 不跑真实 SVG 布局）；e2e 探针验证真实渲染留给人工验收。
- **L**：logger.warn `render.mermaid.error`（仅失败路径）。

### F-R4 数学公式（KaTeX）
- **G**：`$$…$$`（行内/块级）渲染为 KaTeX 公式。
- **AC**：
  - AC-R4-1：行内 `$$E=mc^2$$` 与块级公式均渲染出 `.katex` 元素；
  - AC-R4-2：非法 LaTeX 不崩溃（KaTeX error 占位）；
  - AC-R4-3：`$` 货币符号（如 "价格 $5"）不被误判为公式。
- **T**：vitest — 公式块渲染断言（jsdom 下 katex 输出 span 结构）。
- **L**：无新增。

### F-R5 排版补齐 + 表格增强 + 图片 lightbox
- **G**：`.md` 内容区排版达到 GitHub 观感；表格可横向滚动；图片点击放大预览。
- **AC**：
  - AC-R5-1：h1-h4、hr、blockquote、task list checkbox 均有样式（不再浏览器默认）；
  - AC-R5-2：宽表出现横向滚动条，表头有底色区分；
  - AC-R5-3：点击消息内图片弹出 lightbox，可缩放关闭；Esc 可退出；
  - AC-R5-4：深浅两主题下以上样式均正确（用 `data-streamdown` + 设计令牌）。
- **T**：vitest — 表格容器存在 + img 点击挂 lightbox 回调。
- **L**：无新增。

### F-R6 工具输出格式化
- **G**：工具 text 内容可读化：ANSI 转义渲染为颜色、JSON 自动 pretty + 高亮、超长输出折叠。
- **AC**：
  - AC-R6-1：含 ANSI 色码的输出渲染为彩色 span，无残留 `\x1b[` 字样；
  - AC-R6-2：合法 JSON 文本 pretty-print 后按代码块渲染（带语言标签 json）；
  - AC-R6-3：非 JSON 文本原样走 ANSI/纯文本路径；
  - AC-R6-4：超过 2000 字符的输出默认折叠，可展开。
- **T**：vitest 纯函数 — `looksLikeJson` / `prettyJson` 用例；组件 — ANSI 输入渲染断言。
- **L**：logger.debug `render.tool.format`（format 类型：ansi/json/plain）。

### F-R7 流式性能优化
- **G**：历史消息在新 chunk 到达时不重渲染；流式解析压力只作用于末块。
- **AC**：
  - AC-R7-1：`MessageLine`、`BlockView` 包 `React.memo`，props 引用不变则跳过渲染（测试用渲染计数断言）；
  - AC-R7-2：Streamdown `parseIncompleteMarkdown` 仅在流式中的末条消息启用，历史消息静态渲染；
  - AC-R7-3：现有搜索跳转（F-9-2）与虚拟列表 measureElement 行为不回退。
- **T**：vitest — 渲染计数测试（追加 chunk 后历史消息组件渲染次数不增）。
- **L**：无新增。

### F-R8 thinking 内容走 markdown 渲染
- **G**：`ThoughtView` 展开体由 `pre-wrap` 纯文本换成 Streamdown 静态渲染（保持 13px 小字号）。
- **AC**：
  - AC-R8-1：thinking 中含代码围栏/列表时按 markdown 渲染；
  - AC-R8-2：折叠/计时/自动收起交互不变（复用现有测试）；
  - AC-R8-3：批注选区在 thinking 展开体上不可用（明确降级：thinking 是过程性内容）。
- **T**：复用 ChatPanel thinking 测试 + 新增 markdown 元素断言。
- **L**：无新增。

---

## 5. 清理项（ DEC-21 代价回收）

- `src/main.tsx` 移除 `highlight.js/styles/github.css` import；
- `src/index.css` 移除第 269-358 行（`.hljs-*` 深色覆盖 + `.code-block-wrap/.code-copy`）；
- `ChatPanel.tsx` 移除 rehypeHighlight/remarkGfm import 与 CodeBlock 手写组件（Streamdown 内建替代）；
- `App.css` `.md` 段中被 `data-streamdown` 样式取代的规则逐条对照移除（保守起见先保留 p/ul 级基础规则一版，验收后统一删）。

---

## 6. 排期与提交切分

| 顺序 | 内容 | 提交 |
| --- | --- | --- |
| 1 | 依赖安装 + 旧高亮清理 | `chore(deps): P11 依赖切换（streamdown 全家桶 + ansi-to-react + react-photo-view）` |
| 2 | F-R1 + F-R2（Streamdown 接入 + 代码块） | `feat(render): 消息渲染切换 Streamdown，代码块语言标签/复制/双主题` |
| 3 | F-R3 + F-R4（mermaid + math） | `feat(render): mermaid 图与 KaTeX 公式渲染` |
| 4 | F-R5（排版/表格/图片 lightbox） | `feat(render): 排版补齐 + 表格增强 + 图片 lightbox` |
| 5 | F-R6（工具输出格式化） | `feat(render): 工具输出 ANSI/JSON 格式化` |
| 6 | F-R7（流式性能 memo） | `perf(render): 消息组件 memo 化，流式仅末块重解析` |
| 7 | F-R8（thinking markdown） | `feat(render): thinking 展开体走 markdown 渲染` |
| 8 | 验收记录 | `docs(acceptance): P11 渲染增强验收记录` |

直接在 `main` 开发（延续用户指示，不切分支）。

---

## 7. 风险与预案

| 风险 | 预案 |
| --- | --- |
| Streamdown 样式基于 Tailwind 类，需 @source 扫描 | 按官方文档在 index.css 加 `@source` 指令；构建后视觉抽检 |
| mermaid 包体积大（~1MB） | `@streamdown/mermaid` 已按需动态 import；Vite 首包不含 |
| 虚拟列表高度跳变（异步 SVG/字体） | Streamdown 块级渲染为同步 DOM 后由 measureElement 兜底；lightbox 只改 body 层不影响列表 |
| ansi-to-react 对超长输出慢 | 折叠阈值截断后再渲染（2000 字符） |
| KaTeX 字体在离线环境缺失 | katex css 随包内置字体文件，Vite 打包落 asset |
