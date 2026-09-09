// P36 后续：execute 命令的展示层格式化（调研纪要 docs/research/p36-command-formatting.md）。
//
// 纯函数、零依赖：逐字符扫描保留**原文子串**，只在顶层控制操作符（&& || | ;）处断行。
// 为什么不用 shell-quote.parse 重组：parse 会剥引号（echo "a b" → [echo, a b]），
// 重新 join 语义已变；展示层必须零失真——本实现输出 = 原文按规则插入换行，永不改变命令本身。
//
// 规则：
//   - 引号（'…' / "…"）、转义（\x）、$() / `` 子命令内的字符一律不构成操作符
//   - 顶层 && || ; | → 断行，操作符留在行尾，续行缩进 2 空格
//   - 已含换行的原文（LLM 自己排过版）→ null（尊重原排版）
//   - 格式化无断行收益（无顶层操作符）→ null（组件回退原文）
//   - 任何输入都不抛错（渲染层兜底纪律，同 toolDisplay）
//
// 注意：本函数输出仅供展示；CommandView 的复制按钮永远复制原始 command 全文。

const CONTINUATION_INDENT = "  ";

export function formatShellCommand(command: string): string | null {
  // LLM 已自行排版的多行命令 → 不再加工
  if (command.includes("\n")) return null;

  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let subDepth = 0; // $( … ) 嵌套深度

  const ops: { start: number; end: number }[] = [];
  let i = 0;
  while (i < command.length) {
    const ch = command[i];
    if (escaped) {
      escaped = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      i += 1;
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else if (ch === "$" && command[i + 1] === "(") subDepth += 1;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === "$" && command[i + 1] === "(") {
      subDepth += 1;
      i += 2;
      continue;
    }
    if (ch === "`") {
      // 反引号子命令：跳到配对反引号（其内的 \ 转义反引号不计）
      let j = i + 1;
      while (j < command.length && !(command[j] === "`" && command[j - 1] !== "\\")) j += 1;
      i = Math.min(j + 1, command.length);
      continue;
    }
    if (ch === ")" && subDepth > 0) {
      subDepth -= 1;
      i += 1;
      continue;
    }
    // 顶层（非引号/非子命令/非转义）才识别操作符
    if (subDepth === 0) {
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        ops.push({ start: i, end: i + 2 });
        i += 2;
        continue;
      }
      if (ch === ";" || ch === "|") {
        ops.push({ start: i, end: i + 1 });
        i += 1;
        continue;
      }
    }
    i += 1;
  }

  if (ops.length === 0) return null; // 单命令，无断行收益

  // 组装：操作符粘行尾，操作符后断行 + 缩进；断点前后多余空白折叠为单空格
  let out = "";
  let cursor = 0;
  for (const op of ops) {
    let before = command.slice(cursor, op.start).trimEnd();
    const opText = command.slice(op.start, op.end);
    // && || | 与前一 token 间保留单空格（"cd /a &&"）；; 紧贴（"echo a;"）
    if (before.length > 0) out += before + (opText === ";" ? "" : " ");
    out += opText;
    cursor = op.end;
    out += "\n" + CONTINUATION_INDENT;
    // 续行起点：跳过操作符后的空白（含换行前的多余空格），缩进由 CONTINUATION_INDENT 统一给
    while (cursor < command.length && /\s/.test(command[cursor])) cursor += 1;
  }
  out += command.slice(cursor);
  return out;
}
