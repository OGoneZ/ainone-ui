#!/usr/bin/env bash
# e2e 探针运行器：按 harness 可用性跳过不可用的探针，让 `pnpm test` 之外的
# 真实 harness e2e 有统一入口。
#
# 用法：pnpm test:e2e [--filter <子串>]
#   无 harness 依赖的探针（协议层/序列化）可离线跑；
#   依赖 claude-agent-acp / omp / pi-acp 的按 PATH 探测决定是否跳过。
#
# 退出码：任何被选中且可运行的探针失败 → 非 0。

set -euo pipefail
cd "$(dirname "$0")/.."

FILTER="${1:-}"
HAS_CLAUDE=$(command -v claude-agent-acp >/dev/null 2>&1 && echo 1 || echo 0)
HAS_OMP=$(command -v omp >/dev/null 2>&1 && echo 1 || echo 0)
HAS_PI=$(command -v pi-acp >/dev/null 2>&1 && echo 1 || echo 0)

pass=0
skip=0
fail=0

run_probe() {
  local name="$1" dep="$2" file="$3"
  if [ -n "$FILTER" ] && [[ "$name" != *"$FILTER"* ]]; then return; fi
  if [ "$dep" = "claude" ] && [ "$HAS_CLAUDE" != "1" ]; then echo "⏭ 跳过 $name（缺 claude-agent-acp）"; skip=$((skip+1)); return; fi
  if [ "$dep" = "omp" ] && [ "$HAS_OMP" != "1" ]; then echo "⏭ 跳过 $name（缺 omp）"; skip=$((skip+1)); return; fi
  if [ "$dep" = "pi" ] && [ "$HAS_PI" != "1" ]; then echo "⏭ 跳过 $name（缺 pi-acp）"; skip=$((skip+1)); return; fi
  echo "▶ 运行 $name"
  if bun "$file"; then pass=$((pass+1)); else echo "❌ $name 失败"; fail=$((fail+1)); fi
}

#              名称                    依赖      文件
run_probe "perf-回填"                 "none"     tools/spike/e2e-p4-perf-probe.ts
run_probe "load-暗号续聊"             "claude"   tools/spike/e2e-load-probe.ts
run_probe "p4-history-日志回填"        "claude"   tools/spike/e2e-p4-history-probe.ts
run_probe "steering-打断"             "claude"   tools/spike/e2e-steering-probe.ts
run_probe "markdown-渲染源"            "claude"   tools/spike/e2e-markdown-probe.ts
run_probe "parallel-并行隔离"          "omp"      tools/spike/e2e-parallel-probe.ts
run_probe "pi-会话"                   "pi"       tools/spike/e2e-pi-probe.ts
run_probe "p8-fork-分叉"              "claude"   tools/spike/e2e-fork-probe.ts
run_probe "p9-plan-计划栏"             "claude"   tools/spike/e2e-p9-plan-probe.ts
run_probe "p11-bang-命令注入"          "claude"   tools/spike/e2e-p11-bang-probe.ts

echo ""
echo "e2e 结果：$pass 通过 / $skip 跳过 / $fail 失败"
[ "$fail" -eq 0 ]