// P45：omp 会话级切换值归一的单测。
//
// 真机实测（2026-09-12，omp 1.10.0）：
//   set "deepseek-v4-flash"        → Unknown ACP model: deepseek-v4-flash
//   set "ainone/deepseek-v4-flash" → OK
// 即 omp 的 set_config_option 只认 configOptions 里回报的 ref，而候选列表来自
// 网关探测的裸 id。归一错 → 侧栏每次切模型都弹「当前会话不支持该模型」。

import { describe, expect, it } from "vitest";
import { resolveOmpSessionValue } from "./ompModelValue";

/** omp 实测形态的 configOptions（options 的 value=description=`${provider}/${id}`）。 */
function ompOptions(values: Array<[string, string]>) {
  return [
    { category: "mode", type: "select", options: [{ value: "default", name: "Default" }] },
    {
      category: "model",
      type: "select",
      currentValue: values[0]?.[0],
      options: values.map(([value, name]) => ({ value, name, description: value })),
    },
  ];
}

describe("resolveOmpSessionValue", () => {
  it("裸 id → 命中 description（omp 实测形态：value=description=provider/id）", () => {
    const opts = ompOptions([
      ["ainone/deepseek-v4-flash", "deepseek/deepseek-v4.1-flash"],
      ["ainone/glm-5.3", "glm-5.3"],
    ]);
    expect(resolveOmpSessionValue("deepseek-v4-flash", opts)).toBe("ainone/deepseek-v4-flash");
    expect(resolveOmpSessionValue("glm-5.3", opts)).toBe("ainone/glm-5.3");
  });

  it("剥 provider 首段匹配，且只剥一段（网关 id 自身含斜杠）", () => {
    // saver/glm-5.3 的裸 id 含斜杠：剥一段得 "glm-5.3"，绝不能靠 endsWith 匹配
    const opts = ompOptions([
      ["ainone/saver/glm-5.3", "saver/glm-5.3"],
      ["ainone/glm-5.3", "glm-5.3"],
    ]);
    expect(resolveOmpSessionValue("saver/glm-5.3", opts)).toBe("ainone/saver/glm-5.3");
    expect(resolveOmpSessionValue("glm-5.3", opts)).toBe("ainone/glm-5.3");
  });

  it("已是 ref 原样命中（不重复加前缀）", () => {
    const opts = ompOptions([["ainone/glm-5.3", "glm-5.3"]]);
    expect(resolveOmpSessionValue("ainone/glm-5.3", opts)).toBe("ainone/glm-5.3");
  });

  it("分组形态的 options 也能下钻命中", () => {
    const opts = [
      {
        category: "model",
        type: "select",
        options: [{ groupId: "gw", name: "网关", options: [{ value: "ainone/kimi-k3", name: "kimi-k3" }] }],
      },
    ];
    expect(resolveOmpSessionValue("kimi-k3", opts)).toBe("ainone/kimi-k3");
  });

  it("未命中（模型未登记进 models.yml）→ 回退 ainone/ 前缀，不发出裸 id", () => {
    expect(resolveOmpSessionValue("not-listed", ompOptions([["ainone/glm-5.3", "glm-5.3"]]))).toBe(
      "ainone/not-listed",
    );
  });

  it("无 configOptions（会话未回报名单）→ 仍回退带前缀形态", () => {
    expect(resolveOmpSessionValue("glm-5.3", null)).toBe("ainone/glm-5.3");
    expect(resolveOmpSessionValue("glm-5.3", [])).toBe("ainone/glm-5.3");
  });

  it("用户自配 provider 名同样命中（不硬编码 ainone）", () => {
    const opts = ompOptions([["zhubaoduo/duo-king-6.6", "duo-king-6.6"]]);
    expect(resolveOmpSessionValue("duo-king-6.6", opts)).toBe("zhubaoduo/duo-king-6.6");
  });
});
