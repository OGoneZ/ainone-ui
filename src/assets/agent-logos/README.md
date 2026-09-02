# 本地品牌 SVG 资产（P7 · F-7-3 优先级 2）

按 adapterId 命名（`<id>.svg`）。支持两种：

- **彩色 SVG**（含固定 `fill` 颜色）→ 直接内联渲染，保持原品牌色（推荐，识别度最高）。
- **单色 SVG**（含 `currentColor`）→ 经 CSS mask 随主题反色。

已预置（彩色，来源见下）：

| 文件 | harness | 品牌色 | 来源 |
| --- | --- | --- | --- |
| `omp.svg` | Oh My Pi | 黑 π + 橙插件头 | [`oh-my-pi-agent` 官方 `assets/icon.svg`](https://github.com/headev/oh-my-pi-agent) |
| `pi.svg` | Pi | 蓝 `#2563eb` | [simple-icons `pi`](https://simpleicons.org)（π 符号，品牌色重染） |
| `claude-code.svg` | Claude Code | 珊瑚橙 `#D97757` | [thesvg `claude-code` color](https://thesvg.org) |
| `codex.svg` | Codex | OpenAI 紫 `#412991` | [simple-icons `openai`](https://simpleicons.org)（六边形标，品牌色重染） |
| `opencode.svg` | OpenCode | 深灰 `#5A5858` | [simple-icons `opencode`](https://simpleicons.org)（O 方块，官方灰重染） |

未命中的 adapter 走首字母 monogram / Bot 兜底。

> 新增本地 logo：往本目录放 `<id>.svg`（彩色或单色 currentColor 皆可），运行时按 `adapterId` 命中；
> 无需改 `AgentAvatar.tsx`（动态 import 会命中同名文件，未命中自动降级 monogram）。
