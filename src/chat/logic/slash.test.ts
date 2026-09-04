import { describe, it, expect } from "vitest";
import { isSlashInput, filterCommands, completeCommand } from "./slash";
import type { CommandWord } from "@/store/sessionStore";

const words: CommandWord[] = [
  { name: "model", description: "显示模型" },
  { name: "fast", description: "切换快速模式", hint: "[on|off]" },
  { name: "security", description: "安全扫描" },
  { name: "fresh", description: "重置状态" },
];

describe("slash 命令补全（F-4-7）", () => {
  it("isSlashInput 仅在 / 开头为真", () => {
    expect(isSlashInput("/")).toBe(true);
    expect(isSlashInput("/model")).toBe(true);
    expect(isSlashInput("hello")).toBe(false);
    expect(isSlashInput("")).toBe(false);
  });

  it("只有 / 列出全部命令", () => {
    expect(filterCommands(words, "/")).toHaveLength(words.length);
  });

  it("前缀命中断续过滤", () => {
    const r = filterCommands(words, "/f");
    expect(r.map((w) => w.name)).toEqual(["fast", "fresh"]); // 前缀优先
  });

  it("P11 模糊匹配：/clr 命中 security（c…urity…r 子序列）于非命令时排除", () => {
    const r = filterCommands(words, "/mdel");
    expect(r.map((w) => w.name)).toEqual(["model"]); // m…del 子序列
  });

  it("P11 模糊匹配：连续命中排在散布命中前", () => {
    const r = filterCommands(words, "/fas");
    expect(r[0].name).toBe("fast"); // 连续+词首，得分高于 security 里的散布
  });

  it("包含命中断后（无前缀命中）", () => {
    const r = filterCommands(words, "/ecur");
    expect(r.map((w) => w.name)).toEqual(["security"]);
  });

  it("无匹配返回空", () => {
    expect(filterCommands(words, "/zzz")).toEqual([]);
  });

  it("completeCommand 回填 /name + 尾随空格", () => {
    expect(completeCommand({ name: "model", description: "d" })).toBe("/model ");
  });
});
