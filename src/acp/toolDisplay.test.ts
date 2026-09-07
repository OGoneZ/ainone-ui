// P30 AC-2.1/2.2：toolDisplay 纯函数测试——kindIcon 全覆盖 + toolSubtitle 参数提炼。

import { describe, it, expect } from "vitest";
import { kindIcon, kindLabel, toolSubtitle } from "./toolDisplay";
import { ToolIcon, TerminalIcon, FileTextIcon, EditIconKind, DeleteIcon, MoveIcon, SearchIcon, ThinkingIcon, FetchIcon, SwitchModeIcon } from "@/components/ui/icons";

describe("kindIcon（P30 AC-2.1）", () => {
  it("十种协议 kind 全命中对应图标", () => {
    expect(kindIcon("read")).toBe(FileTextIcon);
    expect(kindIcon("edit")).toBe(EditIconKind);
    expect(kindIcon("delete")).toBe(DeleteIcon);
    expect(kindIcon("move")).toBe(MoveIcon);
    expect(kindIcon("search")).toBe(SearchIcon);
    expect(kindIcon("execute")).toBe(TerminalIcon);
    expect(kindIcon("think")).toBe(ThinkingIcon);
    expect(kindIcon("fetch")).toBe(FetchIcon);
    expect(kindIcon("switch_mode")).toBe(SwitchModeIcon);
    expect(kindIcon("other")).toBe(ToolIcon);
  });

  it("缺省/未知 kind（旧日志、harness 未声明）→ 通用扳手兜底", () => {
    expect(kindIcon(undefined)).toBe(ToolIcon);
    expect(kindIcon(null)).toBe(ToolIcon);
    expect(kindIcon("")).toBe(ToolIcon);
    expect(kindIcon("mysterious_kind")).toBe(ToolIcon);
  });
});

describe("kindLabel", () => {
  it("已知 kind 返回中文；未知返回「工具」", () => {
    expect(kindLabel("execute")).toBe("执行");
    expect(kindLabel("edit")).toBe("编辑");
    expect(kindLabel("switch_mode")).toBe("切换模式");
    expect(kindLabel(undefined)).toBe("工具");
    expect(kindLabel("whatever")).toBe("工具");
  });
});

describe("toolSubtitle（P30 AC-2.2）", () => {
  it("command → 原样（换行折叠为空格）", () => {
    expect(toolSubtitle({ command: "git status --short" })).toBe("git status --short");
    expect(toolSubtitle({ command: "echo a\nb" })).toBe("echo a b");
  });

  it("file_path / path → 文件名（末段）", () => {
    expect(toolSubtitle({ file_path: "/a/b/c.ts" })).toBe("c.ts");
    expect(toolSubtitle({ path: "/x/y.json" })).toBe("y.json");
    // file_path 优先于 path
    expect(toolSubtitle({ file_path: "/a.ts", path: "/b.ts" })).toBe("a.ts");
  });

  it("pattern → \"pattern\" + in scope（path 或 glob）", () => {
    expect(toolSubtitle({ pattern: "TODO", path: "/src" })).toBe('"TODO" in /src');
    expect(toolSubtitle({ pattern: "fix", glob: "*.ts" })).toBe('"fix" in *.ts');
    expect(toolSubtitle({ pattern: "solo" })).toBe('"solo"');
  });

  it("url → 原样", () => {
    expect(toolSubtitle({ url: "https://example.com/a" })).toBe("https://example.com/a");
  });

  it("prompt → 截断（子代理任务描述）", () => {
    expect(toolSubtitle({ prompt: "探索架构" })).toBe("探索架构");
  });

  it("超长截断到 80 字符 + 省略号", () => {
    const long = "x".repeat(120);
    expect(toolSubtitle({ command: long })).toHaveLength(81);
    expect(toolSubtitle({ command: long })!.endsWith("…")).toBe(true);
  });

  it("不命中任何已知字段 / 坏形状 → null", () => {
    expect(toolSubtitle({ foo: "bar" })).toBeNull();
    expect(toolSubtitle(undefined)).toBeNull();
    expect(toolSubtitle(null)).toBeNull();
    expect(toolSubtitle(42)).toBeNull();
    expect(toolSubtitle(["a"])).toBeNull();
    expect(toolSubtitle({ command: "" })).toBeNull(); // 空串不算命中
  });
});
