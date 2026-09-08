# ainone-ui · P33 系统集成与分发收尾 · 规格书

**项目名**：ainone-ui —— Agent in One
**文档版本**：v1.0
**日期**：2026-09-08
**状态**：已批准基线（用户 2026-09-08 裁决：系统通知 + 托盘 + 自动更新做；i18n / 全局快捷键唤起待定）
**上游关系**：消化 v1 计划书原 P4（docs/plan.md §7.4）中用户裁决保留的部分——即 gap-audit BASE-02 的落地期。三平台 CI（v1 F-4-1）已由现行 release.yml 兑现，本规格不重复。

---

## 0. 需求总览

| # | 需求 | 级别 | 来源 |
|---|---|---|---|
| F-32-1 | 系统通知：turn 完成 / 权限等待时提醒，点击唤起窗口 | M | v1 F-4-2 + US-5 |
| F-32-2 | 托盘：图标常驻 + 会话数 + 菜单退出清进程 | M | v1 F-4-2 |
| F-33-3 | 自动更新：updater 插件 + CI 签名清单 + 设置页检查更新 | M | v1 F-4-4 |
| — | i18n 中/英 | **待定** | v1 F-4-3（用户暂缓，将来想做随时可做） |
| — | 全局快捷键唤起 | **待定** | v1 F-4-2 部分（应用内快捷键已丰富，用户暂缓） |
| — | 代码签名（macOS 公证） | **明确不做** | v1 F-4-5 W 项，用户重申不买 Apple 开发者账号 |

**版本号/tag 前提（用户既定决策）**：tag 由所有者择机打（gap-audit BASE-01 裁决）。自动更新完全依赖「每次 Release 版本号严格递增」，因此 F-33-3 的生效前提是**发版时 bump 版本号**——本规格把这一条写进 F-33-3 的 CI 语义，不改 tag 节奏本身。

---

## 1. 调研结论（2026-09-08，依赖与平台事实）

| 需求 | 结论 | 依据 |
|---|---|---|
| F-32-1 | **tauri-plugin-notification v2**（官方插件，Rust + JS 双端）。权限模型：macOS 首次发送触发系统授权弹窗，Linux 走 dbus（libayatana-appindicator 已在 CI Linux 依赖里），Windows toast 无需权限 | tauri 官方插件生态；仓库 tauri 2.x |
| F-32-2 | **tauri 2 内建 tray-icon feature**（无需第三方插件）：`TrayIconBuilder` + `MenuBuilder`，图标/菜单/点击事件齐全。macOS 用模板图标（monochrome）自适应深浅色 | tauri 2 core feature `tray-icon` |
| F-33-3 | **tauri-plugin-updater v2**（官方）。产物签名：`tauri signer generate` 生成密钥对（私钥本地保存不入库，公钥进 conf）。CI 侧 `tauri-action` 开 `createUpdaterArtifacts` 自动产出签名包 + 重写 latest.json 为 updater 格式 | tauri 官方 updater 文档；tauri-action 已在用（release.yml） |
| macOS 无签名边界 | updater 在 macOS 要求 app bundle 签名（ad-hoc 不够，须 Developer ID），**未签名 DMG 下 macOS 端自动更新不可用**——本规格如实降级：macOS 上「检查更新」功能保留，但只跳转下载页/Release 页手动安装。Windows（NSIS/MSI）与 Linux（AppImage）无签名也能完整走 updater | tauri updater 文档「未签名 macOS 不支持」明示；用户明确不买签名 |

**选型金标准核对**：三项全部是 Tauri 官方插件/内建能力，零自研协议层；业务粘合只有「触发决策纯函数 + 菜单文案」。

---

## 2. 统一测试要求

承接 TESTING.md 分层：纯函数 vitest / 组件 vitest+jsdom / Rust cargo test。
铁律：凡「输入确定 → 输出确定」的逻辑抽纯函数并配单测。

- 通知触发决策 `shouldNotify`：纯函数（输入 = 事件类型 + 窗口聚焦态 + 活跃 tab 归属）。
- 托盘会话数格式化：纯函数（0/1/N 文案）。
- updater 的版本比较交给插件（内部语义化版本比较，不自研）。

日志：`notify.fire`（含 reason/tabKey）/ `tray.action` / `updater.check` 各一条；失败 warn。

---

## 3. 各 F 项规格

### F-32-1 系统通知（M）

**触发规则**（防打扰优先——只在「用户看别处」时提醒）：

1. **turn 完成**：`session/prompt` 响应到达（stopReason 任意）且**主窗口失焦** → 通知「{adapter 名} 任务完成」+ 消息首行摘要（≤60 字符）。stopReason = cancelled（用户自己取消）不通知。
2. **权限等待**：`session/request_permission` 到达且**主窗口失焦** → 通知「{adapter 名} 等待权限批准」+ 工具名。
3. **窗口聚焦时不发**（用户正盯着）；**活跃会话在当前聚焦 tab 时不发**（即用户虽切走了但那个 tab 就是活跃 tab 的情形不可能发生，此条兜底）。
4. 点击通知体 → 唤起并聚焦主窗口（Rust 侧 `set_focus`）。
5. 队列自动续跑造成的中间 turn 结束同样触发（每 turn 一条；连续队列消费的刷屏属可接受范围，不做合并——保持简单，干扰大了用户可关系统通知）。

**实现要点**：
- 触发点在 ChatPanel `runPrompt` 的 turn 收尾（finally 之前的 stopReason 已知处）与权限 `patch(tabKey, { perm })` 处——两处都已集中，且 `document.hasFocus()`（或 Tauri window focus 事件）可判失焦。
- 发送走 Rust command `notify_send(title, body)`（插件 Rust API），不在 WebView 里直接调 JS 端插件——统一权限/日志路径。
- `shouldNotify(reason, windowFocused)` 纯函数：`reason: "turn_end" | "perm"`；turn_end 需附 stopReason。测试锁定：聚焦不 发 / cancelled 不发 / 失焦发。
- macOS 首次通知的授权弹窗属系统行为，规格不处理（用户拒绝则收不到，README 故障排查补一句）。

**验收**：
- **AC-P33-1**：窗口失焦时 agent 跑完一个 turn → 收到系统通知，含 adapter 名与任务完成信息；点击通知 → 窗口唤起聚焦。
- **AC-P33-2**：窗口失焦时 agent 请求权限 → 收到「等待权限批准」通知（工具名可见）。
- **AC-P33-3**：窗口聚焦时同样场景 → 无任何通知。
- **AC-P33-4**：用户主动停止（cancelled）→ 无通知。
- **AC-P33-5**：`shouldNotify` 纯函数 vitest 全绿（聚焦/失焦/cancelled/perm 四态矩阵）。

### F-32-2 托盘（M）

**形态与语义**：

1. 应用启动即创建托盘图标（各平台内嵌 icon 派生；macOS 走 template 图标自适应深浅色）。
2. 托盘 tooltip 与菜单首行显示运行中会话数：`运行中 N 个会话`（N=0 显示「空闲中」）。数字由前端在 busy 集变化时经轻量 command 推送（`tray_set_busy_count(n)`），Rust 不反查业务状态——保持 Rust 薄。
3. 菜单项：
   - 「显示主窗口」（点击图标本体同效）→ show + set_focus；
   - 「运行中 N 个会话」（只读展示，禁用态）；
   - 「退出」→ **先走既有清理链**（agent::on_exit_cleanup + terminal::on_exit_cleanup）再退出，复用 RunEvent::Exit 路径——即 `app.exit(0)` 触发 RunEvent::Exit 而非裸 std::process::exit。
4. **关窗语义维持现状**（关窗 = 退出应用，RunEvent::Exit 清理兜底不变）——不引入「关窗隐藏到托盘」的第二退出语义（避免与现有 AC-P1-7/AC-P2-5 的「关窗必无残留」预期冲突；若将来要驻留托盘另立规格）。
5. Linux：tray 依赖 libayatana-appindicator（CI Linux 依赖清单已含）。

**实现要点**：
- `src-tauri/src/tray.rs` 新模块：`setup_tray(app)` + `tray_set_busy_count` command + 菜单事件处理。菜单文案纯函数 `busy_label(n)` 单测（0/1/N 三态）。
- 前端在 `useSessionStore` busy 变化处（App 编排层，订阅 runtime 聚合）防抖推送计数。

**验收**：
- **AC-P33-6**：应用启动后系统托盘出现 ainone-ui 图标；点击图标/菜单「显示主窗口」→ 窗口显示聚焦。
- **AC-P33-7**：发起一个长任务 → 托盘菜单显示「运行中 1 个会话」；结束后变「空闲中」。
- **AC-P33-8**：托盘菜单「退出」→ 应用退出，`pgrep -f <harness-cmd>` 与终端 PTY 均无残留（2 秒内），与关窗退出等价。
- **AC-P33-9**：`busy_label` 纯函数 vitest + Rust 侧菜单构建 cargo test 全绿。

### F-33-3 自动更新（M）

**架构**：

1. **密钥**：`pnpm tauri signer generate -w ~/.tauri/ainone-ui.key`（本地一次性操作；私钥**永不入库**，密码同样不入库）。公钥写入 `tauri.conf.json > plugins > updater > pubkey`。
2. **构建侧**：conf 开 `bundle.createUpdaterArtifacts: true` → tauri build 产出每平台更新产物（macOS app.tar.gz、Windows nsis zip、Linux AppImage tar.gz）并生成 `.sig` 签名文件。
3. **发布侧（release.yml publish 作业）**：
   - 上传更新产物到 R2（现有平铺逻辑扩展文件名匹配：`*.tar.gz`、`*.AppImage.tar.gz`、`*.nsis.zip` 及对应 `.sig`）；
   - **latest.json 重写为 updater v1 格式**：`{ version, notes, pub_date, platforms: { "darwin-aarch64": { signature, url }, "darwin-x86_64": ..., "windows-x86_64": ..., "linux-x86_64": ... } }`——signature 取 `.sig` 文件内容，url 指向 R2 更新产物。现有「门户七卡」下载清单 latest.json **保留不动**（另存 `downloads.json` 或共存双文件，实施时定，原则：updater 消费的文件与人工下载清单解耦，互不干扰）。
   - 版本递增门禁复用现有 preflight（tag == conf），并**新增校验：updater latest.json 的 version 必须严格大于 R2 上现存 latest.json 的 version**（防手滑降级发布——jq 比较 semver）。
4. **应用侧**：
   - `tauri-plugin-updater` 接入，启动后**不自动检查**（本地优先、不打扰）；设置页「关于」区新增「检查更新」按钮；
   - 点击 → 查询 R2 `latest.json` → 有新版：展示版本号 + 更新说明 + 「下载并安装」；无新版：toast「已是最新版本」；
   - 下载进度条（插件自带 download 事件）→ 完成后按平台语义安装重启（Win/Linux 走插件 install；**macOS 未签名 → 该路径不可用**，见降级）；
   - **macOS 降级**：conf 保留 pubkey 与 updater 依赖（跨平台同构），但检测到 macOS 时「下载并安装」替换为「前往下载页」按钮（打开 Release/门户页，opener 插件）。判定用 `std::env::consts::OS`/`navigator.platform`，纯展示层分支。
5. **端点**：`https://pkg.zhubaoduo.com/latest-updater.json`（新文件名，与现 latest.json 解耦；R2 路径不变）。

**验收**：
- **AC-P33-10**：`tauri signer generate` 产出的密钥对存在；私钥在 .gitignore 保护范围外（本地文件），pubkey 已进 conf；**私钥未出现在任何仓库文件中**（grep 审计）。
- **AC-P33-11**：本地 `pnpm tauri build` 产出更新产物 + `.sig` 签名文件（macOS 腿即可验证产出形态）。
- **AC-P33-12**：CI（打 tag 干跑或发布后核验）：publish 作业产出 updater 格式 latest-updater.json，platforms 四键齐全且 signature 非空、url 可访问（curl 200）。
- **AC-P33-13**：Windows/Linux 实机：从 0.2.0 装的应用点「检查更新」→ 发现新版 → 下载进度 → 安装重启后「关于」版本号变化。（**实施注意**：需两个版本号真实发布，跨版本验证放在下次所有者打 tag 时自然发生；开发期先以「检查更新 → 已是最新版本」分支 + mock 端点组件测试替代验收，实机升级链路标记为随下次发布验证。）
- **AC-P33-14**：macOS：设置页显示「前往下载页」（不显示「下载并安装」）；点击打开下载页。
- **AC-P33-15**：设置页「检查更新」组件测试（无新版 toast / 有新版面板 / macOS 分支渲染）+ updater 相关 Rust 侧走查（无自研版本比较）。
- **AC-P33-16**：CI 门禁测试：降级版本 tag 被拒绝（本地模拟 jq semver 比较逻辑单测）。

---

## 4. 明确不做（本期）

| 项 | 理由 |
|---|---|
| i18n 中/英 | 用户裁决待定（暂缓，将来想做随时可做，不阻塞任何功能） |
| 全局快捷键唤起 | 用户裁决待定（应用内快捷键体系 P25 已丰富） |
| macOS 代码签名/公证 | 用户明确不购买 Apple 开发者账号；macOS 自动更新因此降级为跳转下载页（F-33-3 第 4 条） |
| 关窗驻留托盘（关窗=隐藏） | 与既有「关窗必无残留」验收预期冲突，避免第二退出语义 |
| 自动启动检查更新 | 本地优先、不打扰原则；用户主动检查 |

---

## 5. 风险登记

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-33-1 | 私钥/密码泄漏（误提交） | 低 | 高 | 私钥存 ~/.tauri（仓库外）；CI 经 GitHub Secrets 注入（TAURI_SIGNING_PRIVATE_KEY/PASSWORD）；grep 审计入 AC-P33-10 |
| R-33-2 | latest-updater.json 与下载清单互相踩 | 中 | 中 | 双文件解耦（latest.json 不动，新文件 latest-updater.json） |
| R-33-3 | macOS 用户装了无签名 app 期待自动更新 | 高 | 低 | 设置页如实显示「前往下载页」；README 故障排查写明 macOS 更新方式 |
| R-33-4 | Linux 托盘在无 appindicator 的桌面环境不显示 | 低 | 低 | Debian/Ubuntu 主流环境已覆盖；不显示则无托盘功能（无副作用），README 注明 |
| R-33-5 | 通知权限被系统拒绝（macOS 首弹） | 中 | 低 | README 故障排查：系统设置里开通知；应用侧发送失败静默 warn 不弹 UI |

---

## 6. 提交切分（小步提交纪律）

1. `docs(p33): 规格书`（本文档）
2. `feat(p33): 系统通知——插件接入 + shouldNotify 决策 + turn 完成/权限到达触发`（含 S1 全部测试）
3. `feat(p33): 托盘——tray.rs + 会话数推送 + 菜单退出清理链`（含 S2 全部测试）
4. `feat(p33): 自动更新应用侧——updater 插件 + 设置页检查更新 + macOS 降级分支`（含 S3 应用侧测试）
5. `ci(release): updater 产物签名与 latest-updater.json 发布 + 版本递增门禁`
6. `docs(acceptance): P33 验收记录`

---

## 7. 需求追溯

| 需求 | 溯源 | 验收 |
|---|---|---|
| F-32-1 | v1 plan.md F-4-2/US-5 + gap-audit BASE-02 裁决 | AC-P33-1…5 |
| F-32-2 | v1 plan.md F-4-2 + AC-P4-4 语义 | AC-P33-6…9 |
| F-33-3 | v1 plan.md F-4-4 + 用户「不买签名」约束 | AC-P33-10…16 |

---

## 8. 变更记录

| 日期 | 版本 | 变更 | 决策人 |
|---|---|---|---|
| 2026-09-08 | v1.0 | 初版：系统通知/托盘/自动更新三 M 项；i18n 与全局快捷键登记待定；macOS 无签名降级明示 | 所有者 + Claude |
