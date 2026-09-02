// fileTree 纯函数单测：排除清单过滤 / 路径拼接 / diff 路径收集（AC-P9-19）。

import { describe, it, expect } from "vitest";
import {
  shouldExcludeDir,
  filterExcluded,
  joinDirPath,
  collectModifiedPaths,
  EXCLUDED_DIRS,
} from "./fileTree";
import type { ChatMsg } from "./message-log";

describe("shouldExcludeDir", () => {
  it("排除清单命中", () => {
    for (const d of EXCLUDED_DIRS) expect(shouldExcludeDir(d)).toBe(true);
  });

  it("普通目录不排除", () => {
    expect(shouldExcludeDir("src")).toBe(false);
    expect(shouldExcludeDir("docs")).toBe(false);
  });
});

describe("filterExcluded", () => {
  it("目录命中清单 → 排除；文件不排除", () => {
    const entries = [
      { name: "node_modules", is_dir: true },
      { name: ".git", is_dir: true },
      { name: "src", is_dir: true },
      { name: "README.md", is_dir: false },
    ];
    expect(filterExcluded(entries)).toEqual([
      { name: "src", is_dir: true },
      { name: "README.md", is_dir: false },
    ]);
  });
});

describe("joinDirPath", () => {
  it("拼接子目录绝对路径（去尾斜杠）", () => {
    expect(joinDirPath("/a/b", "c")).toBe("/a/b/c");
    expect(joinDirPath("/a/b/", "c")).toBe("/a/b/c");
  });
});

describe("collectModifiedPaths", () => {
  it("收集 diff 块的 path（去重）", () => {
    const msgs: ChatMsg[] = [
      {
        role: "assistant",
        blocks: [
          {
            kind: "tool",
            toolCallId: "t1",
            title: "edit",
            status: "done",
            content: [{ kind: "diff", diff: { path: "/a/b.ts", oldText: "", newText: "x" } }],
          },
          {
            kind: "tool",
            toolCallId: "t2",
            title: "edit",
            status: "done",
            content: [{ kind: "diff", diff: { path: "/a/b.ts", oldText: "", newText: "y" } }],
          },
        ],
      },
    ];
    const set = collectModifiedPaths(msgs);
    expect([...set]).toEqual(["/a/b.ts"]);
  });

  it("无视 user 消息与非 diff 内容", () => {
    const msgs: ChatMsg[] = [
      { role: "user", text: "hi" },
      {
        role: "assistant",
        blocks: [
          { kind: "text", text: "无 diff" },
        ],
      },
    ];
    expect(collectModifiedPaths(msgs).size).toBe(0);
  });
});
