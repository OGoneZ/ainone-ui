// 路径规范化纯函数：与 Rust workspaces.rs 的 normalize_path 保持一致（去尾部斜杠 + 小写）。
// 用于前端判断「同一目录」是否已被工作区占用，避免与 Rust 侧按 cwd 去重的语义不一致。

export function normPath(p: string): string {
  return p.replace(/\/+$/, "").toLowerCase();
}
