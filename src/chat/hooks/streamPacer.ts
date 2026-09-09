// 流式输出平滑揭示器（P35，2026-09-09）：
//
// 背景：harness SSE chunk 平均 ~121ms/条（P31 实测 396 条/48s），每条几十字，
// 且到达突发不均（300ms 空窗后 3 条齐到）。P31 的 rAF 节流只合并「同一帧内的
// 多条」，到达节奏被原样透传 → 用户看到「隔一会蹦出几个字」。
//
// 解法（社区共识，2026-09-09 调研）：buffer 收全量 + 独立揭示时钟——
//   targetCps = clamp(pending / 目标延迟, minCps, maxCps)
//   pending 超过 catchUpThreshold 时切换更短延迟 → 落后越多揭示越快（自动清积压）
//   EMA 平滑速率防突变；charBudget += cps × dt；每帧揭示 min(budget, maxPerCommit) 个字素
// 形状对齐 markstream-core（DeepChat 在用）与 Convex useSmoothText 的比例控制器。
//
// 安全切分：
//   - Intl.Segmenter grapheme 切分——CJK/emoji 永不在中间断裂
//   - 未闭合 code fence 阻塞：``` 之后的 pending 内容等闭合才揭示（半个代码块
//     抖出来比晚一秒显示更伤观感；markstream 同款 atomic reveal 简化版）。
//     fence 状态按行增量扫描（不重扫全文）。
//
// 语义保证：
//   - 不丢字：flush() 揭示全部 pending（turn 结束收口，对齐 P31 flush 语义）
//   - reduced-motion 直通：onChunk 立即全量揭示（零 pacing 开销）
//   - now 注入：测试确定性

export interface StreamPacerOptions {
  /** 揭示速率下限（字符/秒）——pending 很少时也保持的底速 */
  minCps?: number;
  /** 揭示速率上限（字符/秒）——catch-up 的天花板 */
  maxCps?: number;
  /** 目标延迟（ms）：稳态时 pending ≈ cps × latency */
  targetLatencyMs?: number;
  /** catch-up 延迟（ms）：pending 超阈值后用的更短延迟 → 揭示加速 */
  catchUpLatencyMs?: number;
  /** 进入 catch-up 的积压阈值（字符） */
  catchUpThreshold?: number;
  /** 揭示提交帧率（每秒最多 tick 次数；跳过过近的帧） */
  commitFps?: number;
  /** 单次揭示字符上限（防单帧巨额提交卡顿） */
  maxCharsPerCommit?: number;
  /** reduced-motion 直通 */
  reducedMotion?: boolean;
}

const DEFAULTS = {
  minCps: 40,
  maxCps: 2000,
  targetLatencyMs: 900,
  catchUpLatencyMs: 350,
  catchUpThreshold: 600,
  commitFps: 30,
  maxCharsPerCommit: 120,
  reducedMotion: false,
};

export interface StreamPacer {
  /** 事件到达：累积 pending（无节奏保证，任意频率调用） */
  onChunk(text: string): void;
  /** 每帧推进揭示；返回 true = revealed 有变化（调用方应提交），false = 无变化 */
  tick(now: number): boolean;
  /** 揭示全部 pending（turn 结束/异常收口） */
  flush(): void;
  /** 已揭示的全文快照 */
  revealedText(): string;
  /** 尚未揭示的积压量 */
  pendingCount(): number;
  /** 清理（幂等；只重置时钟，已揭示内容保留） */
  dispose(): void;
}

/** 行首围栏标记（``` 或 ~~~，CommonMark）。返回围栏字符（` 或 ~）或 null。 */
function fenceStart(line: string): string | null {
  const m = /^\s*(```|~~~)/.exec(line);
  return m ? m[1].charAt(0) : null;
}

/**
 * 行级增量 fence 门（逐字素判定）。step(ch) 喂入「准备揭示的下一个字素」：
 *   - true        该字素直接放行（调用方 append 到 revealed）
 *   - string      闭合事件：阻塞区（含闭合行）整体回吐，调用方按序 append——
 *                 顺序由 gate 内部保证，不会与后续放行内容交错
 *   - false       阻塞（围栏内行内容：gate 内部 held 缓冲持有）
 * O(1)/字素，行缓冲与揭示流严格同步（字素必被消费一次且仅一次）。
 */
function createFenceGate() {
  let open = false;
  let fenceChar = "";
  let line = ""; // 当前未完结行（open 状态下也持续累积——闭合行判定需要）
  let held = ""; // 围栏内被阻塞的字素

  return {
    step(ch: string): boolean | string {
      line += ch;
      if (ch === "\n") {
        const fence = fenceStart(line);
        if (open && fence === fenceChar) {
          // 闭合围栏行：held（代码内容）+ 闭合行整体回吐——一次 append 保时序
          open = false;
          fenceChar = "";
          const out = held + line;
          held = "";
          line = "";
          return out;
        }
        if (!open && fence) {
          // 开启围栏行：本行（含换行）放行，之后内容进入阻塞区
          open = true;
          fenceChar = fence;
          line = "";
          return true;
        }
        line = "";
        return !open;
      }
      if (open) {
        held += ch; // 围栏内行内容：持有不揭示
        return false;
      }
      return true;
    },
    /** 是否仍在未闭合围栏内 */
    isOpen: () => open,
    /** 强制收割 held（仅 flush 用：终态无视阻塞语义） */
    drainHeld(): string {
      const out = held;
      held = "";
      return out;
    },
  };
}

/** grapheme 切分器（Intl.Segmenter 的 lib-ES2020 安全封装；不可用环境回退码点切分） */
interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}

function createSegmenter(): GraphemeSegmenter | null {
  const Ctor = (Intl as unknown as { Segmenter?: new (locale: string, opts: { granularity: string }) => GraphemeSegmenter }).Segmenter;
  if (!Ctor) return null;
  try {
    return new Ctor("zh", { granularity: "grapheme" });
  } catch {
    return null;
  }
}

function toUnits(pending: string, seg: GraphemeSegmenter | null): string[] {
  if (seg) return Array.from(seg.segment(pending), (s) => s.segment);
  return Array.from(pending);
}

export function createStreamPacer(options: StreamPacerOptions = {}, now: () => number = Date.now): StreamPacer {
  void now; // now 由 tick(now) 注入；此参数保留为测试钩子占位（与 P31 throttle 惯例对齐）
  const opts = { ...DEFAULTS, ...options };
  const seg = createSegmenter();

  let revealed = ""; // 已揭示全文
  let pending = ""; // 未揭示积压
  let cps = opts.minCps; // 当前揭示速率（EMA 平滑后）
  let budget = 0; // 字符预算（cps × dt 累积）
  let lastTick: number | null = null;
  const minFrameMs = 1000 / opts.commitFps;
  const gate = createFenceGate();

  function reveal(n: number): void {
    if (n <= 0 || pending.length === 0) return;
    const units = toUnits(pending, seg);
    const take = Math.min(n, units.length);
    if (take <= 0) return;
    // 逐字素过 fence 门：状态机对预算内字素全部消费（闭合判定在换行时发生，
    // 中途丢喂会让 line 错位）；返回 false 的字素进 gate.held（不进 revealed），
    // 闭合时随 drainHeld 整体放行——pending 与 gate 状态严格同步无重复消费。
    for (let i = 0; i < take; i++) {
      const r = gate.step(units[i]);
      if (r === true) revealed += units[i];
      else if (typeof r === "string") revealed += r; // 闭合事件：阻塞区整体接回
    }
    pending = units.slice(take).join("");
  }

  if (opts.reducedMotion) {
    return {
      onChunk(text) {
        revealed += text;
      },
      tick() {
        return false;
      },
      flush() {},
      revealedText: () => revealed,
      pendingCount: () => 0,
      dispose() {},
    };
  }

  return {
    onChunk(text) {
      if (!text) return;
      pending += text;
    },
    tick(nowMs) {
      if (lastTick !== null) {
        const dt = Math.min(Math.max(0, nowMs - lastTick), 100); // 帧间隔钳制（markstream 同款）
        if (dt < minFrameMs) return false; // 跳帧：commitFps 上限
        if (pending.length > 0) {
          // —— 比例控制器：目标速率 = pending / 目标延迟 ——
          const latency =
            pending.length > opts.catchUpThreshold ? opts.catchUpLatencyMs : opts.targetLatencyMs;
          const targetCps = Math.min(
            opts.maxCps,
            Math.max(opts.minCps, (pending.length * 1000) / latency),
          );
          // EMA 平滑（0.2 系数，markstream 同款）
          cps += (targetCps - cps) * 0.2;
          budget += (cps * dt) / 1000;
          const n = Math.min(Math.floor(budget), opts.maxCharsPerCommit);
          if (n > 0) {
            budget -= n;
            const before = revealed.length;
            reveal(n);
            return revealed.length > before;
          }
          return false;
        }
        // 无积压：预算清零（防「下一批到达瞬间全量倾泻」）
        budget = 0;
      }
      lastTick = nowMs;
      return false;
    },
    flush() {
      // 揭示全部（含 fence 内与 held 阻塞区——终态必须完整）
      revealed += pending + gate.drainHeld();
      pending = "";
      budget = 0;
      lastTick = null;
    },
    revealedText: () => revealed,
    pendingCount: () => pending.length,
    dispose() {
      lastTick = null;
    },
  };
}
