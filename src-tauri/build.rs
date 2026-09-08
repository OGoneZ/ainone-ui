fn main() {
    // AINONE_TARGET_TRIPLE：resource_dir/runtime/ 下的内嵌 bun 目录名（P31）。
    // 交叉编译时用 cargo 传入的 TARGET，宿主构建回落 HOST（两者 = tauri bundler
    // 定位产物的同一套 triple）。build script 环境变量经 cargo:rustc-env 注入。
    let target = std::env::var("TARGET")
        .or_else(|_| std::env::var("HOST"))
        .unwrap_or_else(|_| "unknown-target".into());
    println!("cargo:rustc-env=AINONE_TARGET_TRIPLE={target}");
    tauri_build::build()
}
