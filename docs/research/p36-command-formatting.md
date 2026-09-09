# 调研：terminal 命令格式化（P36 后续）

> 背景：LLM 执行的 execute 命令常是 `;`、`&&` 串联的一长串，P36 R1 已在工具卡展开时
> 全文显示（`tool-command` 块），但可读性差。本文调研社区方案，评估本仓可行性。
> 结论先行：**推荐「shell-quote 解析 + 自研轻排版」方案，不引入 WASM formatter。**

## 一、需求特征

我们要处理的不是「格式化 shell 脚本文件」，而是**单条命令行**的展示层排版：

- 输入：一行 LLM 生成的命令（可含 `&&` `||` `;` `|` 重定向、引号、env 前缀）
- 输出：多行等宽展示，操作符换行 + 缩进，视觉分组
- 约束：纯前端、零拷贝安全（渲染不可执行）、失败可降级为原文

## 二、社区方案盘点

| 方案 | 形态 | 体积 | 评价 |
|---|---|---|---|
| **shfmt**（mvdan/sh） | Go CLI | — | 金标准，但需本地二进制；Go/WASM 路线重 |
| **sh-syntax** | shfmt 编译为 WASM 的 npm 包 | ~794 KB unpacked（wasm 主导） | 真解析器，正确性最高；WASM 体积/冷启动对「展示一行命令」过重；webview 主线程初始化成本明显 |
| **prettier-plugin-sh** | prettier + sh-syntax | 拖入整个 prettier | 更重，仓库无 prettier 运行时依赖，排除 |
| **shell-quote** | 纯 JS parse/quote | ~43 KB unpacked（运行时 ~10 KB） | 成熟（npm 周下载千万级）、零依赖；`parse()` 返回 token 流且**识别操作符**（`{op:'&&'}`、`{op:'|'}`、comment 等），引号/env 展开 `$VAR` 也处理 |
| Metaist 格式化思路（2024 博文） | ~40 行正则 tokenizer | 0 | 按 `; && || |` 断行的参考实现，需自己处理引号边界 |
| explainshell | 在线服务 | — | 逐参数解释，方向不同（需后端+手册库） |

## 三、推荐：shell-quote + 轻排版（两段式）

1. `shell-quote.parse(cmd)` → token 数组（word / {op} / comment）
2. 纯函数排版（本仓自写，~60 行，参考 Metaist 规则）：
   - `{op:'&&'|'||'|';'}` 换行，操作符留在行尾（或行首，实现时定一种），续行缩进 2 空格
   - `{op:'|'}` 换行，续行对齐管道竖线
   - 引号内 token 不拆（parse 已保证）
   - parse 抛错（畸形命令）→ 原文直出，永不失败
3. 展示位置：`CommandView`（P36 R1 命令段）内新增「格式化视图」，默认开，
   提供「原始/格式化」小切换；复制按钮永远复制**原始全文**（保证可回放执行）

## 四、为何不选 WASM formatter

- sh-syntax 正确性最高，但 wasm 加载 ~1-2 MB、主线程实例化在 WKWebView 上可感；
  我们的对象是「一行命令」不是脚本文件，操作符断行已解决 90% 可读性
- 命令来自 LLM，偶发畸形串——shell-quote 解析失败可优雅降级，shfmt 解析失败同样要降级，
  收益差被体积差抹平
- 若未来确需完整脚本格式化（如用户编辑 shell 文件预览），再按需动态 import sh-syntax

## 五、风险与边界

- shell-quote 对 Windows CMD 语法不支持（本仓终端即 POSIX shell，无碍）
- `parse` 默认会剥离注释——展示层无碍（LLM 命令罕见行内注释，且原文兜底可切换）
- 排版是纯展示层：不改 rawInput 存档，不影响复制/重放语义
