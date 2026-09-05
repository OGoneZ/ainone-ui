// @vitest-environment jsdom
// VoiceInput 测试（F-9-5 AC-P9-20/21/22 组件侧 + Rust 单测覆盖 background 解析）：
// mock MediaRecorder / getUserMedia，验证 录音状态机 + 转写回填 + 权限拒绝。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VoiceInput } from "./VoiceInput";

vi.mock("@/ipc/asr", () => ({
  asrTranscribe: vi.fn().mockResolvedValue("这是转写文本"),
}));

// logger 走 @tauri-apps/plugin-log（依赖 Tauri invoke），jsdom 无 Tauri → mock 掉
vi.mock("@/lib/logger", () => ({
  logger: {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { asrTranscribe } from "@/ipc/asr";

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state = "inactive";
  stream: any;
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  constructor(stream: any) {
    this.stream = stream;
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    // 触发 dataavailable + stop，模拟录到音频
    this.ondataavailable?.({ data: new Blob(["x"]) });
    setTimeout(() => this.onstop?.(), 0);
  }
}

beforeEach(() => {
  FakeRecorder.instances = [];
  // jsdom 无 navigator.mediaDevices → 先构造
  (navigator as any).mediaDevices = { getUserMedia: vi.fn() };
  navigator.mediaDevices.getUserMedia = vi
    .fn()
    .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  (window as any).MediaRecorder = FakeRecorder;
});
afterEach(cleanup);

describe("VoiceInput", () => {
  it("点语音 → 录音开始（时长可见）→ 停止 → 转写回填（AC-P9-20）", async () => {
    const onTranscribed = vi.fn();
    render(<VoiceInput onTranscribed={onTranscribed} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "语音输入" }));
    // 录音中：按钮文案变为停止录音
    expect(screen.getByRole("button", { name: "停止录音" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "停止录音" }));
    // 转写后回填（F-15-5：按钮已 icon-only，断言麦克风图标按钮回归）
    await screen.findByRole("button", { name: "语音输入" });
    expect(onTranscribed).toHaveBeenCalledWith("这是转写文本");
  });

  it("麦克风权限被拒 → 明确提示，不崩溃（AC-P9-21）", async () => {
    navigator.mediaDevices.getUserMedia = vi.fn().mockRejectedValue(new Error("denied"));
    render(<VoiceInput onTranscribed={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "语音输入" }));
    // 仍回到 idle 态（不崩溃），无录音开始
    expect(await screen.findByRole("button", { name: "语音输入" })).toBeInTheDocument();
  });

  it("ASR 服务端失败 → 回到 idle，输入框可继续手动用（AC-P9-22）", async () => {
    const mockAsr = vi.mocked(asrTranscribe);
    mockAsr.mockRejectedValueOnce(new Error("服务端不可达"));
    const onTranscribed = vi.fn();
    render(<VoiceInput onTranscribed={onTranscribed} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "语音输入" }));
    await user.click(screen.getByRole("button", { name: "停止录音" }));
    // 失败后回到 idle（可再次录音）
    await screen.findByRole("button", { name: "语音输入" });
    expect(onTranscribed).not.toHaveBeenCalled();
  });
});
