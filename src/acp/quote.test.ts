// composeQuotedPrompt 单测：多段/单段/空疑问/空原文 边界（AC-P8-9）。

import { describe, it, expect } from "vitest";
import { composeQuotedPrompt } from "./quote";

describe("composeQuotedPrompt", () => {
  it("单段：产出 [引用 1] + 原文 + 疑问", () => {
    const out = composeQuotedPrompt([{ text: "某段原文", question: "为什么？" }]);
    expect(out).toBe("[引用 1] 某段原文\n疑问：为什么？");
  });

  it("多段：序号递增，段间 --- 分隔", () => {
    const out = composeQuotedPrompt([
      { text: "A", question: "问A" },
      { text: "B", question: "问B" },
      { text: "C", question: "问C" },
    ]);
    expect(out).toBe(
      "[引用 1] A\n疑问：问A\n---\n[引用 2] B\n疑问：问B\n---\n[引用 3] C\n疑问：问C",
    );
  });

  it("空疑问：仍产出「疑问：」空行（确定性，不崩溃）", () => {
    const out = composeQuotedPrompt([{ text: "原文", question: "" }]);
    expect(out).toBe("[引用 1] 原文\n疑问：");
  });

  it("空原文：仍产出引用占位（确定性，不崩溃）", () => {
    const out = composeQuotedPrompt([{ text: "", question: "这段是什么" }]);
    expect(out).toBe("[引用 1] \n疑问：这段是什么");
  });

  it("空数组：产出空串", () => {
    expect(composeQuotedPrompt([])).toBe("");
  });
});
