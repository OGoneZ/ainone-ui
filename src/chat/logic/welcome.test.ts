import { describe, it, expect } from "vitest";
import { welcomeGreeting, suggestionsFor } from "./welcome";
import type { AdapterWithStatus } from "@/ipc/adapters";

const adapter = (name: string): AdapterWithStatus => ({
  id: "x",
  name,
  program: "x",
  args: [],
  cwd: ".",
  logo: null,
  available: true,
  resolvedPath: null,
  source: null,
});

describe("欢迎页（F-6-3）", () => {
  it("按小时给时间段问候", () => {
    expect(welcomeGreeting(3)).toBe("夜深了");
    expect(welcomeGreeting(9)).toBe("早上好");
    expect(welcomeGreeting(14)).toBe("下午好");
    expect(welcomeGreeting(20)).toBe("晚上好");
    // 边界
    expect(welcomeGreeting(0)).toBe("夜深了");
    expect(welcomeGreeting(12)).toBe("下午好");
    expect(welcomeGreeting(18)).toBe("晚上好");
  });

  it("建议 prompt 携带 adapter 名（差异化）", () => {
    const a = suggestionsFor(adapter("Claude Code"));
    const b = suggestionsFor(adapter("Codex"));
    expect(a[0]).toContain("Claude Code");
    expect(b[0]).toContain("Codex");
    expect(a[0]).not.toBe(b[0]);
  });
});
