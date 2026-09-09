// P37 R1：流式输出速率计算器（tok/s 估算）。
//
// 数据模型：测「到达侧」字符增量（P35 pacer.onChunk 的同一输入流），不测
// 「揭示侧」——揭示是 30fps 匀速假象，测它得到的是 pacing 参数不是模型速率。
//
// 协议事实：ACP 无逐 token 计量流（usage_update 是上下文占用、分钟级粒度；
// PromptResponse.usage 是 turn 终态）。速率只能是估算：字符增量 ÷ 时间 ÷
// charsPerToken（CJK 占比插值），turn 结束后若有权威 outputTokens 再回算。
//
// 零依赖纯逻辑，时钟/采样可注入，可单测。

const WINDOW_MS = 10_000; // 滑动窗口：10s 内的字符增量参与速率
const MIN_WINDOW_CHARS = 20; // 窗口内字符过少 → 速率不可信（null，防 0 跳动）
const EMA_ALPHA = 0.35; // 估算值平滑系数（单次突发不抖）
const MAX_SAMPLES = 200; // 样本上限（长 turn 内存有界，超限丢最旧）
/** CJK 占比 → 每字符 token 数线性插值端点：纯中文 ≈1.5 字/token，纯英文 ≈4 字符/token */
const CJK_CHARS_PER_TOKEN = 1.5;
const LATIN_CHARS_PER_TOKEN = 4;

export interface StreamRate {
  /** 到达侧字符增量（与 pacer.onChunk 同点位喂入）；时间戳显式传入 */
  onChunk(text: string, now: number): void;
  /** 窗口估算 tok/s（EMA 平滑后）；窗口空/样本不足 → null */
  rate(now: number): number | null;
  /** turn 收口回算：有权威 outputTokens → 精确均值；无 → 冻结最后 EMA */
  finalize(totalOutputTokens: number | null, endedAt: number): void;
  /** 显示值：流中 = rate()；结束后 = finalize 冻结值 */
  display(now: number): number | null;
  /** 下轮 turn 复位 */
  reset(): void;
}

export function createStreamRate(): StreamRate {
  /** (时间, 字符增量) 样本；text 增量按窗口累计，不存全文（内存有界） */
  let samples: Array<{ ts: number; chars: number; cjk: number }> = [];
  let ema: number | null = null; // 平滑后的估算 tok/s
  /** finalize 后的冻结显示值；null = 未收口或无数据 */
  let frozen: number | null = null;
  let startedAt: number | null = null; // 首 chunk 时刻（finalize 均值分母）
  let totalChars = 0; // 累计字符（finalize 无终值时的兜底参考）
  let totalCjk = 0;

  /** CJK 字符判定：CJK 统一表意文字 + 假名 + 谚文（ surrogate pair 遍历） */
  function cjkRatio(chars: number, cjk: number): number {
    if (chars <= 0) return 0;
    return cjk / chars;
  }

  /** charsPerToken：CJK 占比在 1.5（纯中文）~4（纯英文）间线性插值 */
  function charsPerTokenFor(ratio: number): number {
    return LATIN_CHARS_PER_TOKEN + (CJK_CHARS_PER_TOKEN - LATIN_CHARS_PER_TOKEN) * ratio;
  }

  return {
    onChunk(text, t) {
      if (!text) return;
      if (frozen !== null) return; // 已收口（异常流残余事件）不污染冻结值
      let cjk = 0;
      // code point 遍历（emoji/CJK 扩展区不切半）
      for (const ch of text) {
        const cp = ch.codePointAt(0) ?? 0;
        if (
          (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
          (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
          (cp >= 0x3040 && cp <= 0x30ff) || // 假名
          (cp >= 0xac00 && cp <= 0xd7af) || // 谚文
          (cp >= 0xf900 && cp <= 0xfaff) // 兼容表意
        ) {
          cjk += 1;
        }
      }
      if (startedAt === null) startedAt = t;
      totalChars += text.length;
      totalCjk += cjk;
      samples.push({ ts: t, chars: text.length, cjk });
      if (samples.length > MAX_SAMPLES) samples.shift(); // 丢最旧（内存有界）
      // 每 chunk 即时更新 EMA（读侧 rate(now) 只做窗口裁剪 + 重算缓存）——
      // 增量算，避免 display() 每秒全量重算
      const r = windowRate(t);
      if (r !== null) {
        ema = ema === null ? r : ema + EMA_ALPHA * (r - ema);
      }
    },

    rate(t) {
      if (frozen !== null) return frozen;
      // 裁剪过期样本后再算一次（display 轮询时距上次 onChunk 可能已隔数秒）
      const r = windowRate(t);
      if (r === null) return ema === null ? null : null; // 窗口已空 → 不显示（EMA 是流中值，空窗不放出）
      ema = ema === null ? r : ema + EMA_ALPHA * (r - ema);
      return ema;
    },

    finalize(totalOutputTokens, endedAt) {
      if (frozen !== null) return;
      if (startedAt === null) return; // 无任何 chunk：保持 null（纯 tool turn）
      const elapsedS = Math.max(0.001, (endedAt - startedAt) / 1000);
      if (totalOutputTokens !== null && totalOutputTokens > 0) {
        // 权威终值：turn 输出 token ÷ 首 chunk→收口墙钟
        frozen = totalOutputTokens / elapsedS;
      } else {
        // 无权威值：冻结窗口 EMA 的最后估算（若有），否则按全程字符均摊兜底
        if (ema !== null) {
          frozen = ema;
        } else {
          const ratio = cjkRatio(totalChars, totalCjk);
          frozen = totalChars / charsPerTokenFor(ratio) / elapsedS;
        }
      }
      samples = []; // 收口释放样本
    },

    display(t) {
      if (frozen !== null) return frozen;
      return this.rate(t);
    },

    reset() {
      samples = [];
      ema = null;
      frozen = null;
      startedAt = null;
      totalChars = 0;
      totalCjk = 0;
    },
  };

  /** 滑动窗口速率：窗口内字符增量 ÷ 窗口时长 ÷ charsPerToken；样本不足 → null */
  function windowRate(t: number): number | null {
    // 裁剪窗口外样本
    if (samples.length > 0) {
      const cutoff = t - WINDOW_MS;
      let drop = 0;
      while (drop < samples.length && samples[drop].ts < cutoff) drop += 1;
      if (drop > 0) samples = samples.slice(drop);
    }
    if (samples.length === 0) return null;
    let chars = 0;
    let cjk = 0;
    let firstTs = samples[0].ts;
    for (const s of samples) {
      chars += s.chars;
      cjk += s.cjk;
      if (s.ts < firstTs) firstTs = s.ts;
    }
    if (chars < MIN_WINDOW_CHARS) return null; // 样本太少不可信
    const spanS = Math.max(0.5, (t - firstTs) / 1000); // 窗口时间跨度（≥0.5s 防除零尖峰）
    const ratio = cjkRatio(chars, cjk);
    return chars / charsPerTokenFor(ratio) / spanS;
  }
}
