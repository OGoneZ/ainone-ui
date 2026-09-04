// 语音输入按钮（P9 · F-9-5）：录音 → 上传 ASR → 转写回填输入框。
//
// 状态机：idle → recording → transcribing → 回填 / 错误。
// 麦克风权限被拒 / 服务端失败 → toaster 提示，不崩溃。

import { useEffect, useRef, useState } from "react";
import { asrTranscribe } from "../ipc/asr";
import { logger } from "../lib/logger";
import { toast } from "sonner";

interface Props {
  /** 转写文本回填（不自动发送，可编辑确认） */
  onTranscribed: (text: string) => void;
}

type VoiceState = "idle" | "recording" | "transcribing";

export function VoiceInput({ onTranscribed }: Props) {
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

  async function start() {
    if (state !== "idle") return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toast.error("未授权麦克风，请在系统设置允许麦克风权限");
      logger.warn("asr", "record-start 失败：麦克风权限被拒");
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
    <button
      type="button"
      aria-label={state === "recording" ? "停止录音" : "语音输入"}
      className="voice-btn inline-flex h-9 px-2.5 shrink-0 items-center justify-center gap-1 rounded-full text-xs"
      style={{
        backgroundColor: state === "recording" ? "var(--danger)" : "var(--bg-2)",
        color: state === "recording" ? "#fff" : "var(--text-secondary)",
        transitionDuration: "var(--motion-default)",
      }}
      onClick={state === "recording" ? stop : start}
    >
      {state === "recording" ? (
        <>🔴 {seconds}s</>
      ) : state === "transcribing" ? (
        <>转写中…</>
      ) : (
        <>🎤 语音</>
      )}
    </button>
  );
}
