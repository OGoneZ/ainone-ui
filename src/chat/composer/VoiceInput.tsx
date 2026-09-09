// 语音输入按钮（P9 · F-9-5）：录音 → 上传 ASR → 转写回填输入框。
//
// 状态机：idle → recording → transcribing → 回填 / 错误。
// 麦克风权限被拒 / 服务端失败 → toaster 提示，不崩溃。

import { useEffect, useRef, useState } from "react";
import { asrTranscribe } from "@/ipc/asr";
import { logger } from "@/lib/logger";
import { openUrl } from "@tauri-apps/plugin-opener";
import { MicIcon, StopIcon } from "@/components/ui/icons";
import { toast } from "sonner";

/** 跳转系统设置「隐私与安全性 → 麦克风」页（打开失败静默，toast 已给出手动路径）。 */
function openMicrophoneSettings(): Promise<void> {
  return openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
}

interface Props {
  /** 转写文本回填（不自动发送，可编辑确认） */
  onTranscribed: (text: string) => void;
  /** P25：注册「开关录音」回调（Alt+\ 全局快捷键触发；toggle=idle 时 start、recording 时 stop） */
  registerToggle?: (fn: () => void) => void;
}

type VoiceState = "idle" | "recording" | "transcribing";

export function VoiceInput({ onTranscribed, registerToggle }: Props) {
  const [state, setState] = useState<VoiceState>("idle");
  const [seconds, setSeconds] = useState(0);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      mediaRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // P25：向父级注册开关回调（toggle = 快捷键入口；录音态天然留在本组件）
  useEffect(() => {
    if (!registerToggle) return;
    registerToggle(() => {
      if (state === "recording") stop();
      else if (state === "idle") void start();
    });
    // state 变化时重注册（闭包捕获最新 state）；转写中不响应快捷键
  }, [registerToggle, state]);

  async function start() {
    if (state !== "idle") return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // 区分被拒（引导去系统设置，Tauri 打包版需 Info.plist 声明才会弹授权框）
      // 与无设备（纯提示）；其余按未知错误兜底。
      const name = e instanceof DOMException ? e.name : "";
      if (name === "NotAllowedError") {
        toast.error("麦克风权限被拒，请在系统设置 → 隐私与安全性 → 麦克风 中允许本应用", {
          action: { label: "打开系统设置", onClick: () => void openMicrophoneSettings() },
        });
        logger.warn("asr", "record-start 失败：麦克风权限被拒");
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        toast.error("未检测到可用的麦克风设备");
        logger.warn("asr", "record-start 失败：无麦克风设备");
      } else {
        toast.error(`无法开始录音：${String(e)}`);
        logger.warn("asr", "record-start 失败", { err: String(e) });
      }
      return;
    }
    logger.info("asr", "record-start");
    chunksRef.current = [];
    const rec = new MediaRecorder(stream);
    mediaRef.current = rec;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
      const ms = seconds * 1000;
      logger.info("asr", "record-stop", { ms });
      if (blob.size === 0) {
        setState("idle");
        setSeconds(0);
        toast.error("未录到音频，请重试");
        return;
      }
      setState("transcribing");
      try {
        const buf = new Uint8Array(await blob.arrayBuffer());
        const text = await asrTranscribe(buf, `voice-${Date.now()}.webm`);
        logger.info("asr", "transcribe-ok", { chars: text.length });
        onTranscribed(text);
        toast.success("转写完成");
      } catch (e) {
        logger.warn("asr", "transcribe-fail", { err: String(e) });
        toast.error(`转写失败：${String(e)}`);
      } finally {
        setState("idle");
        setSeconds(0);
      }
    };
    rec.start();
    setState("recording");
    setSeconds(0);
    timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
  }

  function stop() {
    if (state !== "recording") return;
    if (timerRef.current) clearInterval(timerRef.current);
    mediaRef.current?.stop();
  }

  return (
    // F-15-5（DEC-45）：icon-only 圆钮（与发送/停止同规格），去 emoji 与大字；
    // 语义走 aria-label/title，录音态秒数用小徽标。
    <button
      type="button"
      aria-label={state === "recording" ? "停止录音" : "语音输入"}
      title={state === "recording" ? `停止录音（${seconds}s）` : "语音输入"}
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
      style={{
        backgroundColor: state === "recording" ? "var(--danger)" : "var(--bg-2)",
        color: state === "recording" ? "#fff" : "var(--text-secondary)",
        transitionDuration: "var(--motion-default)",
      }}
      onClick={state === "recording" ? stop : start}
    >
      {state === "recording" ? (
        <>
          <StopIcon style={{ width: 14, height: 14, strokeWidth: 1.75 }} />
          <span
            aria-hidden="true"
            className="voice-seconds"
            style={{ fontSize: 10, marginLeft: 2, color: "#fff" }}
          >
            {seconds}s
          </span>
        </>
      ) : state === "transcribing" ? (
        <span aria-label="转写中" style={{ fontSize: 12 }}>
          …
        </span>
      ) : (
        <MicIcon style={{ width: 16, height: 16, strokeWidth: 1.75 }} />
      )}
    </button>
  );
}
