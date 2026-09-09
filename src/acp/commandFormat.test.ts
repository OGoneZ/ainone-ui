// P36 后续：formatShellCommand——execute 命令展示层格式化纯函数。
// 核心诉求（Rule 9）：格式化输出必须是原文子串拼接（零失真，引号/转义原样），
// 只在顶层控制操作符处断行；任何不满足展示安全前提的输入 → null 回退原文。

import { describe, it, expect } from "vitest";
import { formatShellCommand } from "./commandFormat";

describe("formatShellCommand（P36 命令格式化）", () => {
  it("顶层 && 断行：操作符行尾，续行缩进 2 空格", () => {
    expect(formatShellCommand("cd /a && npm run build")).toBe("cd /a &&\n  npm run build");
  });

  it("多操作符（; && || | 混合）逐个断行，空白折叠", () => {
    expect(
      formatShellCommand("echo a;  cd /b  &&  FOO=1 bar ||  echo no | tee log"),
    ).toBe("echo a;\n  cd /b &&\n  FOO=1 bar ||\n  echo no |\n  tee log");
  });

  it("引号内的操作符不是断点（零失真）", () => {
    expect(formatShellCommand('echo "a && b" | grep x')).toBe('echo "a && b" |\n  grep x');
    expect(formatShellCommand("echo 'x; y'")).toBeNull(); // 引号内 ; 不构成顶层操作符
  });

  it("转义字符后的操作符不构成断点（\\; 字面分号）", () => {
    expect(formatShellCommand("echo a\\;b")).toBeNull();
    expect(formatShellCommand("echo a\\&&b")).toBeNull();
  });

  it("$( ) 与反引号子命令内的操作符不构成断点", () => {
    expect(formatShellCommand("echo $(git log && date)")).toBeNull();
    expect(formatShellCommand("echo `foo | bar`")).toBeNull();
    expect(formatShellCommand("echo $(a | b) | tee f")).toBe("echo $(a | b) |\n  tee f");
  });

  it("已含换行的命令（LLM 自排版）→ null 尊重原文", () => {
    expect(formatShellCommand("cd /a &&\nnpm run build")).toBeNull();
  });

  it("单命令（无顶层操作符）→ null", () => {
    expect(formatShellCommand("ls -la")).toBeNull();
  });

  it("空输入 → null（不抛错）", () => {
    expect(formatShellCommand("")).toBeNull();
  });
});
