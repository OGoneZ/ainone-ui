# P0 协议报文存档

omp（Oh My Pi v18.1.0）ACP 真实会话报文存档，作为 ainone-ui 协议层的**唯一回归基线**（见 plan.md §8）。

## 采集环境

- 采集日期：2026-09-01
- omp 版本：18.1.0（`omp acp --model duo-king-6.6 --approval-mode=always-ask`）
- 协议版本：ACP v1（`protocolVersion: 1`）
- 模型：duo-king-6.6（自建 OpenAI 兼容网关，`~/.omp/agent/models.yml` 自定义 provider）

## 完整会话存档（JSONL）

| 文件 | 触发命令 | 内容 |
|---|---|---|
| `omp-acp-session.jsonl` | spike 脚本全流程（initialize → session/new → 两个 prompt） | 33 条，含纯对话流式回复 + fs/write 工具链路 |
| `omp-acp-permission-read.jsonl` | 「读取 /tmp/acp-spike/readme-src.txt 并复述」 | 含 fs/read_text_file 回调往返 |
| `omp-acp-always-ask.jsonl` | `--approval-mode=always-ask` 下写文件 | 权限批准路径（allow_once） |

## 单类型样例（P1 状态机回放测试输入）

每类报文一条标准样例，`docs/protocol-samples/sample-*.json`：

| 样例文件 | 事件类型 | 触发方式 |
|---|---|---|
| `sample-agent-message-chunk.json` | `session/update` · agent_message_chunk | 对话回复流式块 |
| `sample-agent-thought-chunk.json` | `session/update` · agent_thought_chunk | 模型思考流式块 |
| `sample-tool-call.json` | `session/update` · tool_call | agent 调用工具（bash/write） |
| `sample-tool-call-update.json` | `session/update` · tool_call_update | 工具状态更新（in_progress/completed） |
| `sample-usage-update.json` | `session/update` · usage_update | token 用量统计 |
| `sample-session-info-update.json` | `session/update` · session_info_update | 会话元信息更新 |
| `sample-available-commands-update.json` | `session/update` · available_commands_update | 可用斜杠命令清单 |
| `sample-request-permission.json` | `session/request_permission`（A→C 请求） | always-ask 模式下 agent 要执行 bash |
| `sample-fs-read-text-file.json` | `fs/read_text_file`（A→C 请求） | 让 agent 读一个文件 |
| `sample-fs-write-text-file.json` | `fs/write_text_file`（A→C 请求） | 让 agent 用 write 工具写文件 |

## 关键协议事实（P1 实现必读）

1. **initialize 响应结构**：`{protocolVersion: 1, agentInfo: {name: 'oh-my-pi', title, version}, authMethods: [...]}`
2. **权限选项结构**：`options: [{optionId, name, kind}]`，kind 取值 `allow_once` / `allow_always` / `reject_once` / `reject_always`；响应格式 `{outcome: {outcome: 'selected', optionId: <选中的>}}`
   - ⚠️ 踩坑记录：返回非标准结构（如 `{outcome:'rejected'}`）时 agent 报 "unknown option ID: undefined" 并把工具标记为 failed
3. **消息流样貌**：`session/prompt` 发出后，先收到 `available_commands_update`、`session_info_update`，然后按需出现 `agent_thought_chunk`（多条）→ `tool_call` → `tool_call_update`（多条）→ `agent_message_chunk`（多条，流式）→ `usage_update` → `session_info_update`
4. **omp 的工具语义**：写文件优先走 `fs/write_text_file`（需要 client 实现）；当权限被拒或无 fs 能力时会降级用 bash/内置 js 执行器（此时**不经** ACP terminal 回调，在 omp 进程内执行）
5. **terminal/* 回调未观察到**：omp ACP 模式下 bash 在 omp 进程内执行，不请求 client terminal 能力——ainone-ui 的 terminal 面板按 `tool_call` 内容渲染即可，`terminal/create` 等 ACP 回调列为可选实现（Zed 等编辑器才常用）
