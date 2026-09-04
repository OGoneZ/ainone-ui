// fs 命令：ACP 的 fs/* 回调代理（读/写本地绝对路径文件）+ 路径解析。
//
// 注意：fd_write 是「本地用户确认后」的代理写盘。路径须由前端在权限审批
// 弹窗中向用户展示并确认后，才允许调用本命令。默认不做任何路径白名单，
// 把裁决权交给用户侧 UI。

/// 读本地文本文件（ACP fs/read_text_file 的代理）。
#[tauri::command]
pub fn fd_read(path: String) -> Result<String, String> {
    let r = std::fs::read_to_string(&path);
    r.map_err(|e| {
        log::warn!("[fs_read] 读取失败 {path}: {e}");
        format!("读取失败 {}: {}", path, e)
    })
}

/// 写本地文本文件（ACP fs/write_text_file 的代理；自动建父目录）。
#[tauri::command]
pub fn fd_write(path: String, content: String) -> Result<(), String> {
    log::debug!("[fs_write] 写入 {path}（{} 字节）", content.len());
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    std::fs::write(&path, content).map_err(|e| {
        log::warn!("[fs_write] 写入失败 {path}: {e}");
        format!("写入失败 {}: {}", path, e)
    })
}

/// 把可能是相对的路径解析成绝对路径（ACP 要求 cwd 为绝对路径）。
#[tauri::command]
pub fn abs_path(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if p.is_absolute() {
        Ok(path)
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(p))
            .map_err(|e| format!("解析当前目录失败: {e}"))?
            .to_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "路径含非法字符".to_string())
    }
}
