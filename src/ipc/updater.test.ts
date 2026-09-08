import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkForUpdate, isMacOS } from "./updater";

// P32 AC-P32-15：检查更新三分支。mock 插件层——封装层只做结果归一，
// 版本比较与验签是插件职责（不自研），此处锁定的是「结果 → UI 三态」映射。

const { checkMock } = vi.hoisted(() => ({ checkMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));

beforeEach(() => {
  checkMock.mockReset();
});

describe("checkForUpdate 三分支（F-32-3）", () => {
  it("插件返回 null → up-to-date（无新版）", async () => {
    checkMock.mockResolvedValue(null);
    const r = await checkForUpdate();
    expect(r.kind).toBe("up-to-date");
    expect(r.version).toBeUndefined();
  });

  it("插件返回 Update → available，版本号与说明透传", async () => {
    checkMock.mockResolvedValue({ version: "9.9.9", body: "修复若干问题" });
    const r = await checkForUpdate();
    expect(r.kind).toBe("available");
    expect(r.version).toBe("9.9.9");
    expect(r.notes).toBe("修复若干问题");
  });

  it("插件抛错 → error，不冒泡（检查失败给 UI 可读态）", async () => {
    checkMock.mockRejectedValue(new Error("网络不可达"));
    const r = await checkForUpdate();
    expect(r.kind).toBe("error");
    expect(r.message).toContain("网络不可达");
  });
});

describe("isMacOS 降级判定（AC-P32-14）", () => {
  it("macOS UA → true（走前往下载页）", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    expect(isMacOS()).toBe(true);
    vi.unstubAllGlobals();
  });

  it("Windows UA → false（可走 downloadAndInstall）", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    expect(isMacOS()).toBe(false);
    vi.unstubAllGlobals();
  });
});
