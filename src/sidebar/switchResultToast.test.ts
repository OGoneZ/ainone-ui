// P32e R6：模型切换结果提示模板单测——「持久落盘 × 会话生效」二维正交。
//
// WHY：此前四条 pick 分支各自硬编码 toast 文案（omp「即时生效」/ claude-code
// 「对新会话生效」/ pi「仅本会话生效」/ error 各说各话），五家用户在同一功能上
// 得到不一致的反馈语义。模板函数把二维组合收敛为可枚举档位——矩阵里任何一格
// 的文案变更都必须显式改这里，防止文案再漂移。

import { describe, it, expect } from "vitest";
import { switchResultToast } from "./ModelSwitchPanel";

describe("switchResultToast（持久落盘 × 会话生效 二维模板）", () => {
  it("created（配置代写新建）：success + 对新会话生效", () => {
    const t = switchResultToast({ persisted: "created", sessionApplied: undefined });
    expect(t.kind).toBe("success");
    expect(t.message("m1")).toBe("已写入 m1（配置新建，对新会话生效）");
    expect(t.detail("/path/to/conf")).toBe("配置已写入 /path/to/conf");
  });

  it("written + 会话即时生效（omp/pi）：success", () => {
    const t = switchResultToast({ persisted: "written", sessionApplied: true });
    expect(t.kind).toBe("success");
    expect(t.message("m1")).toBe("已切换到 m1（本会话即时生效）");
    expect(t.detail("cfg bak")).toBe("cfg bak");
  });

  it("written + 对新会话生效（设置页链路 sessionApplied=undefined）：success", () => {
    const t = switchResultToast({ persisted: "written", sessionApplied: undefined });
    expect(t.kind).toBe("success");
    expect(t.message("m1")).toBe("已切换到 m1（对新会话生效）");
  });

  it("written + 会话拒绝（claude-code 选择器外模型）：warning 不谎报已切换", () => {
    const t = switchResultToast({ persisted: "written", sessionApplied: false });
    expect(t.kind).toBe("warning");
    expect(t.message("m1")).toBe("已写入 m1（对新会话生效）");
    expect(t.detail("cfg bak")).toBe("当前会话不支持该模型，未能即时切换。cfg bak");
  });

  it("none + 会话生效（pi 仅会话级）：success + 明示无持久写回", () => {
    const t = switchResultToast({ persisted: "none", sessionApplied: true });
    expect(t.kind).toBe("success");
    expect(t.message("m1")).toBe("当前会话已切换到 m1（仅本会话生效）");
    expect(t.detail()).toBeUndefined();
  });

  it("none + 会话拒绝：error + 点名 harness 无写回", () => {
    const t = switchResultToast({ persisted: "none", sessionApplied: false });
    expect(t.kind).toBe("error");
    expect(t.message("m1")).toBe("当前会话不支持该模型");
    expect(t.detail(undefined, "Pi")).toBe("Pi 无配置写回，无法持久化");
    expect(t.detail(undefined)).toBe("该 harness 无配置写回，无法持久化");
  });
});
