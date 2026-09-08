// 工作区文件树（P9 · F-9-4）：读单层目录（懒加载，不递归）。
//
// 命令 `workspace_list_dir(path)` 返回 { name, is_dir }[]，按名排序。
// 错误路径（不存在 / 无权限 / 是文件）返回结构化错误不崩。
// 大目录排除清单（node_modules/.git/target/dist/build）在前端过滤（见 src/acp/fileTree.ts），
// 本命令只做底层「列目录」，保持单一职责。

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// 纯函数：读单层目录并排序（目录优先，各自按名升序，忽略大小写）。
pub(crate) fn list_dir_sorted(path: &str) -> Result<Vec<DirEntry>, String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    if !p.is_dir() {
        return Err(format!("不是目录: {path}"));
    }
    let rd = std::fs::read_dir(p).map_err(|e| format!("读取目录失败 {path}: {e}"))?;
    let mut entries: Vec<DirEntry> = Vec::new();
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                log::warn!("[list_dir] 跳过无法读取的条目 {path}: {e}");
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        // P29：点开头条目（.github/.env/.gitignore 等）照常返回——VS Code 式显示；
        // 隐藏/排除权统一在前端排除清单（.git/node_modules/.DS_Store 等）
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(DirEntry { name, is_dir });
    }
    entries.sort_by(|a, b| {
        a.is_dir
            .cmp(&b.is_dir)
            .reverse()
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn workspace_list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let entries = list_dir_sorted(&path)?;
    log::debug!("[list_dir] {path} → {} 项", entries.len());
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmpdir(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("ainone-fslist-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn list_dir_returns_names_and_dirs_sorted() {
        let d = tmpdir("normal");
        fs::write(format!("{d}/b.txt"), "b").unwrap();
        fs::create_dir(format!("{d}/a_dir")).unwrap();
        fs::write(format!("{d}/a.txt"), "a").unwrap();

        let entries = list_dir_sorted(&d).unwrap();
        // 目录优先
        assert_eq!(entries[0].name, "a_dir");
        assert!(entries[0].is_dir);
        // 文件按名升序
        let files: Vec<&str> = entries.iter().filter(|e| !e.is_dir).map(|e| e.name.as_str()).collect();
        assert_eq!(files, vec!["a.txt", "b.txt"]);
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn list_dir_nonexistent_returns_err() {
        assert!(list_dir_sorted("/definitely/not/exist/xyz").is_err());
    }

    #[test]
    fn list_dir_on_file_returns_err() {
        let d = tmpdir("file");
        let f = format!("{d}/f.txt");
        fs::write(&f, "x").unwrap();
        assert!(list_dir_sorted(&f).is_err());
        fs::remove_dir_all(d).ok();
    }

    #[test]
    fn list_dir_keeps_dot_entries() {
        // P29 AC-R1-1：点开头文件/文件夹不再被后端吞掉（VS Code 式显示）
        let d = tmpdir("dot");
        fs::create_dir(format!("{d}/.github")).unwrap();
        fs::write(format!("{d}/.env"), "k=v").unwrap();
        fs::write(format!("{d}/.gitignore"), "dist").unwrap();
        fs::write(format!("{d}/.DS_Store"), "junk").unwrap();

        let entries = list_dir_sorted(&d).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&".github"));
        assert!(names.contains(&".env"));
        assert!(names.contains(&".gitignore"));
        assert!(names.contains(&".DS_Store"));
        // .github 是目录且目录优先
        let gh = entries.iter().find(|e| e.name == ".github").unwrap();
        assert!(gh.is_dir);
        fs::remove_dir_all(d).ok();
    }
}
