// @vitest-environment jsdom
// FileTree 测试（F-9-4 AC-P9-14/15/16）：
// mock workspace_list_dir → 文件区渲染；点目录懒加载子项；点文件回调引用。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileTree } from "./FileTree";

vi.mock("../ipc/fslist", () => ({
  workspaceListDir: vi.fn(),
}));

import { workspaceListDir } from "../ipc/fslist";
const mockList = vi.mocked(workspaceListDir);

beforeEach(() => {
  mockList.mockReset();
});
afterEach(cleanup);

describe("FileTree", () => {
  it("渲染 cwd 单层文件树，目录/文件图标区分（AC-P9-14）", async () => {
    mockList.mockResolvedValue([
      { name: "src", is_dir: true },
      { name: "README.md", is_dir: false },
    ]);
    const onRef = vi.fn();
    render(<FileTree cwd="/a/b" modifiedPaths={new Set()} onRefFile={onRef} />);
    const user = userEvent.setup();

    // 展开「文件」
    await user.click(screen.getByRole("button", { name: /文件/ }));
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("点目录 → 懒加载子项；再点收起（AC-P9-15）", async () => {
    mockList.mockImplementation(async (p: string) => {
      if (p === "/a/b") return [{ name: "src", is_dir: true }];
      return [{ name: "index.ts", is_dir: false }];
    });
    render(<FileTree cwd="/a/b" modifiedPaths={new Set()} onRefFile={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /文件/ }));
    await user.click(await screen.findByText("src"));
    expect(await screen.findByText("index.ts")).toBeInTheDocument();

    // 再点收起 → 子项消失（第二次调用 toggle 删 nodes）
    await user.click(screen.getByText("src"));
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
  });

  it("点文件 → onRefFile 回调绝对路径（AC-P9-16）", async () => {
    mockList.mockResolvedValue([{ name: "app.ts", is_dir: false }]);
    const onRef = vi.fn();
    render(<FileTree cwd="/a/b" modifiedPaths={new Set()} onRefFile={onRef} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /文件/ }));
    await user.click(await screen.findByRole("button", { name: "引用 app.ts" }));
    expect(onRef).toHaveBeenCalledWith("/a/b/app.ts");
  });

  it("modifiedPaths 命中 → 文件带「M」徽标（AC-P9-17）", async () => {
    mockList.mockResolvedValue([{ name: "app.ts", is_dir: false }]);
    render(
      <FileTree cwd="/a/b" modifiedPaths={new Set(["/a/b/app.ts"])} onRefFile={() => {}} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /文件/ }));
    expect(await screen.findByText("M")).toBeInTheDocument();
  });
});
