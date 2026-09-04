import { describe, it, expect } from "vitest";
import { filterSessions, relativeTime, type SearchableSession } from "./globalSearch";

const mk = (id: string, title: string, cwd: string, mtime: number): SearchableSession => ({
  session_id: id,
  adapter_id: "omp",
  title,
  cwd,
  mtime_ms: mtime,
});

const entries: SearchableSession[] = [
  mk("s1", "修复登录页白屏", "/home/u/webapp", 1000),
  mk("s2", "ACP session 回填", "/home/u/ainone-ui", 2000),
  mk("s3", "重写日志体系", "/home/u/logs", 3000),
];

describe("filterSessions", () => {
  it("空查询 → 最近 mtime 前 20 条", () => {
    const out = filterSessions(entries, "");
    expect(out.map((e) => e.session_id)).toEqual(["s3", "s2", "s1"]);
  });

  it("fuzzy 命中标题", () => {
    const out = filterSessions(entries, "白屏");
    expect(out.map((e) => e.session_id)).toContain("s1");
  });

  it("fuzzy 命中 cwd", () => {
    const out = filterSessions(entries, "ainone");
    expect(out.map((e) => e.session_id)).toContain("s2");
  });

  it("无命中 → 空", () => {
    expect(filterSessions(entries, "zzzzz")).toEqual([]);
  });

  it("空查询超 20 条截断", () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`k${i}`, `t${i}`, "/w", i));
    expect(filterSessions(many, "")).toHaveLength(20);
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000;
  it("刚刚", () => {
    expect(relativeTime(now - 10_000, now)).toBe("刚刚");
  });
  it("分钟", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
  });
  it("小时", () => {
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小时前");
  });
  it("天", () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2 天前");
  });
});
