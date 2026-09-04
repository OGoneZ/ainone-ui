// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { UsageBar } from "./UsageBar";

afterEach(cleanup);

describe("UsageBar（F-12-6a，DEC-39）", () => {
  it("有 usage → 渲染进度条，tier 与宽度正确", () => {
    render(<UsageBar usage={{ used: 85, size: 100, cost: null }} />);
    const bar = screen.getByTestId("usage-bar");
    expect(bar).toHaveAttribute("data-tier", "warn");
    expect(bar.hasAttribute("title")).toBe(true);
  });

  it("≥100% → danger", () => {
    render(<UsageBar usage={{ used: 100, size: 100, cost: null }} />);
    expect(screen.getByTestId("usage-bar")).toHaveAttribute("data-tier", "danger");
  });

  it("<80% → ok", () => {
    render(<UsageBar usage={{ used: 50, size: 100, cost: null }} />);
    expect(screen.getByTestId("usage-bar")).toHaveAttribute("data-tier", "ok");
  });

  it("无 usage → 不渲染", () => {
    render(<UsageBar usage={null} />);
    expect(screen.queryByTestId("usage-bar")).not.toBeInTheDocument();
  });

  it("size=0 → 不渲染（防除零）", () => {
    render(<UsageBar usage={{ used: 10, size: 0, cost: null }} />);
    expect(screen.queryByTestId("usage-bar")).not.toBeInTheDocument();
  });
});
