// P30 AC-2.1/2.2：toolDisplay 纯函数测试——kindIcon 全覆盖 + toolSubtitle 参数提炼。

import { describe, it, expect } from "vitest";
import { isRiskyCommand, kindIcon, kindLabel, toolCommand, toolOutputFallback, toolSubtitle } from "./toolDisplay";
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

  it("skill：title 已含 skill 名 → null（去重）；title 缺省/不含 → 显示名", () => {
    // claude 桥 title = "Load skill: hello-world"，rawInput.skill = "hello-world"
    // 副标题再显示一遍就是用户实测的「skill 名重复」
    expect(toolSubtitle({ skill: "hello-world" }, "Load skill: hello-world")).toBeNull();
    expect(toolSubtitle({ skill: "hello-world" }, "Load skill")).toBe("hello-world");
    expect(toolSubtitle({ skill: "hello-world" })).toBe("hello-world");
  });
});

// —— P36 R1：toolCommand（命令段数据源）——
describe("toolCommand", () => {
  it("execute + command → 返回原文（不截断不折叠空格，保留换行）", () => {
    const multiline = "echo a \\\n  && echo b   &&   echo c";
    expect(toolCommand("execute", { command: multiline })).toBe(multiline);
  });

  it("kind 缺省（旧日志/粗桥）但 rawInput 有 command → 仍命中", () => {
    expect(toolCommand(undefined, { command: "ls -la" })).toBe("ls -la");
    expect(toolCommand(null, { command: "ls -la" })).toBe("ls -la");
  });

  it("非 execute kind 不命中（read/edit 等不渲染命令段）", () => {
    expect(toolCommand("read", { command: "x" })).toBeNull();
    expect(toolCommand("edit", { command: "x" })).toBeNull();
  });

  it("坏形状 / 空 command → null", () => {
    expect(toolCommand("execute", {})).toBeNull();
    expect(toolCommand("execute", { command: "  " })).toBeNull();
    expect(toolCommand("execute", undefined)).toBeNull();
    expect(toolCommand("execute", null)).toBeNull();
    expect(toolCommand("execute", "ls")).toBeNull();
    expect(toolCommand("execute", 42)).toBeNull();
  });
});

// —— P36 R1：toolOutputFallback（rawOutput 兜底输出）——
describe("toolOutputFallback", () => {
  it("omp 形状 {content:[{type:text,text}]} → 取 text 拼接", () => {
    expect(toolOutputFallback({ content: [{ type: "text", text: "hello" }], details: {} })).toBe("hello");
    expect(toolOutputFallback({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("ab");
  });

  it("纯字符串 → 原样；空串 → null", () => {
    expect(toolOutputFallback("plain out")).toBe("plain out");
    expect(toolOutputFallback("")).toBeNull();
  });

  it("对象无 content → JSON pretty", () => {
    expect(toolOutputFallback({ foo: "bar" })).toBe('{\n  "foo": "bar"\n}');
  });

  it("null/undefined/其他原始值 → null", () => {
    expect(toolOutputFallback(null)).toBeNull();
    expect(toolOutputFallback(undefined)).toBeNull();
    expect(toolOutputFallback(42)).toBeNull();
  });

  it("omp details 私有结构不被解析进输出（只取 content text）", () => {
    const out = toolOutputFallback({
      content: [{ type: "text", text: "line1\nline2" }],
      details: { totalLines: 2, secret: "internal" },
    });
    expect(out).toBe("line1\nline2");
  });
});

// —— P36 反馈：isRiskyCommand（危险命令红色警示）——
describe("isRiskyCommand（P36 危险命令警示）", () => {
  it("删除/覆写类首命令命中", () => {
    expect(isRiskyCommand("rm /Users/x/helloworld.ts")).toBe(true);
    expect(isRiskyCommand("rm -rf /tmp/build")).toBe(true);
    expect(isRiskyCommand("rmdir empty_dir")).toBe(true);
    expect(isRiskyCommand("truncate -s 0 big.log")).toBe(true);
  });

  it("穿透 env 前缀与 sudo", () => {
    expect(isRiskyCommand("FOO=1 rm x")).toBe(true);
    expect(isRiskyCommand("sudo rm -rf /")).toBe(true);
    expect(isRiskyCommand("sudo env rm x")).toBe(true);
  });

  it("绝对路径首命令按 basename 命中", () => {
    expect(isRiskyCommand("/bin/rm x")).toBe(true);
    expect(isRiskyCommand("/usr/sbin/rmdir d")).toBe(true);
  });

  it("多段命令：任意段命中即危险（用户实测场景 bun … && rm …）", () => {
    expect(
      isRiskyCommand('bun /x/tmp/hello.ts && rm /x/tmp/hello.ts && echo "已删除"'),
    ).toBe(true);
    expect(isRiskyCommand("echo done; rm -rf tmp | tee log")).toBe(true);
  });

  it("安全命令不误报", () => {
    expect(isRiskyCommand("git status && npm run build")).toBe(false);
    expect(isRiskyCommand("ls -la")).toBe(false);
    expect(isRiskyCommand("echo rm")).toBe(false); // echo 的参数不算首命令
    expect(isRiskyCommand('echo "rm -rf now"')).toBe(false); // 引号内不判
    expect(isRiskyCommand("")).toBe(false);
  });
});
