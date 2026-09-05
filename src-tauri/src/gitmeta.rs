// git 元数据查询（P15 · F-15-6）：当前分支名。
//
// 命令 `git_current_branch(cwd)`：在 cwd 下执行 `git rev-parse --abbrev-ref HEAD`。
// 非 git 仓库 / git 不存在 / detached HEAD → 结构化错误，前端映射为「—」。

#[cfg(test)]
use std::path::Path;
use std::process::Command;

/// 读 cwd 的当前分支名（纯函数便于测试：git 调用注入）。
#[cfg(test)]
pub(crate) fn current_branch(cwd: &str, mut git: impl FnMut(&str, &str) -> Result<String, String>) -> Result<String, String> {
    if !Path::new(cwd).is_dir() {
        return Err(format!("目录不存在: {cwd}"));
    }
    git("rev-parse", "--abbrev-ref")
}

#[tauri::command]
pub fn git_current_branch(cwd: String) -> Result<String, String> {
    let out = Command::new("git")
        .current_dir(&cwd)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("非 git 仓库或无提交: {}", stderr.trim()));
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() {
        return Err("git 输出为空".to_string());
    }
    Ok(branch)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 目录不存在_报错() {
        let r = current_branch("/nonexistent/path", |_rev, _abbr| Ok("main".into()));
        assert!(r.is_err());
    }

    #[test]
    fn git_成功_返回分支名() {
        let r = current_branch("/tmp", |rev, abbr| {
            assert_eq!(rev, "rev-parse");
            assert_eq!(abbr, "--abbrev-ref");
            Ok("main".into())
        });
        assert_eq!(r.unwrap(), "main");
    }

    #[test]
    fn git_失败_透传错误() {
        let r = current_branch("/tmp", |_, _| Err("非 git 仓库".into()));
        assert!(r.is_err());
    }
}
