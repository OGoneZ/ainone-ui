#!/usr/bin/env node
// P0 spike: 验证 omp 的 ACP 链路（initialize → session/new → session/prompt → 事件流）
// 用法: node tools/spike/acp-probe.js
// 存档: 全部收发报文写入 docs/protocol-samples/（JSONL，供 P1 状态机回放测试）

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'protocol-samples');
const OUT_FILE = path.join(OUT_DIR, 'omp-acp-session.jsonl');

const cmd = process.env.ACP_CMD || 'omp';
const args = (process.env.ACP_ARGS || 'acp').split(' ').filter(Boolean);

// ---- JSON-RPC 收发骨架 ----------------------------------------------------

let nextId = 1;
const pending = new Map(); // id -> {resolve, reject, method}
const log = [];

function send(obj) {
  const line = JSON.stringify(obj);
  log.push({ dir: 'C→A', ...obj });
  child.stdin.write(line + '\n');
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// 处理 agent → client 的请求（ACP client 能力）
async function handleServerRequest(msg) {
  const { method, params, id } = msg;
  log.push({ dir: 'A→C', ...msg });
  switch (method) {
    case 'fs/read_text_file': {
      const text = fs.readFileSync(params.path, 'utf8');
      return { content: text };
    }
    case 'fs/write_text_file': {
      fs.mkdirSync(path.dirname(params.path), { recursive: true });
      fs.writeFileSync(params.path, params.content ?? '');
      return {};
    }
    case 'session/request_permission': {
      // spike 用 allow_once 验证协议往返（optionId 取自 options）；UI 里才弹窗
      const opts = params.options ?? [];
      const allow = opts.find((o) => o.kind === 'allow_once' || o.optionId === 'allow_once');
      console.log(`  [permission] 请求=${JSON.stringify(params.options ?? [])} → 回复=${allow?.optionId ?? 'rejected'}`);
      return { outcome: { outcome: 'selected', optionId: allow?.optionId ?? 'reject_once' } };
    }
    case 'terminal/create':
    case 'terminal/output':
    case 'terminal/wait_for_exit':
    case 'terminal/kill':
      // P1 才实现；spike 记录后返回错误，观察 agent 行为
      log.push({ dir: 'NOTE', note: `spike 未实现 ${method}` });
      throw new Error(`spike: ${method} not implemented`);
    default:
      log.push({ dir: 'NOTE', note: `未知 server 方法 ${method}` });
      throw new Error(`spike: unknown method ${method}`);
  }
}

// ---- 行缓冲 JSONL 解析（只按 LF 切分，DEC-5）-------------------------------

let buf = '';
function onChunk(chunk) {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) onLine(line);
  }
}

function onLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    log.push({ dir: 'PARSE_ERR', line: line.slice(0, 200) });
    return;
  }
  if (msg.id !== undefined && msg.method) {
    // agent → client 请求
    handleServerRequest(msg)
      .then((result) => send({ jsonrpc: '2.0', id: msg.id, result }))
      .catch((err) =>
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: String(err.message || err) } })
      );
  } else if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
    // 对我方请求的响应
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      log.push({ dir: 'A→C', ...msg });
      msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    }
  } else if (msg.method) {
    // 通知
    log.push({ dir: 'A→C', ...msg });
    if (msg.method === 'session/update') onSessionUpdate(msg.params);
  }
}

// ---- 事件流收集 ------------------------------------------------------------

const updates = [];
let messageText = '';

function onSessionUpdate(params) {
  updates.push(params);
  const wb = params?.update?.sessionUpdate;
  if (wb === 'agent_message_chunk') {
    const t = params.update.content?.text ?? '';
    messageText += t;
    process.stdout.write(t);
  } else if (wb === 'agent_thought_chunk') {
    // 思考块：只记不打印
  } else {
    console.log(`\n  [update:${wb}]`);
  }
}

// ---- 主流程 ----------------------------------------------------------------

const child = spawn(cmd, args, {
  env: { ...process.env, PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}` },
  stdio: ['pipe', 'pipe', 'pipe'],
});

child.stdout.on('data', onChunk);
child.stderr.on('data', (c) => process.stderr.write(`[stderr] ${c}`));
child.on('exit', (code) => console.log(`\n[child exit ${code}]`));

function dump() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`\n存档: ${path.relative(ROOT, OUT_FILE)}（${log.length} 条）`);
}

async function main() {
  // ① initialize —— 按 ACP v1 声明 client 能力
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
  });
  console.log(`[initialize] protocolVersion=${init?.protocolVersion} agent=${init?.agent?.name}`);

  // ② session/new
  const sess = await request('session/new', {
    cwd: process.cwd(),
    mcpServers: [],
  });
  const sessionId = sess?.sessionId;
  console.log(`[session/new] sessionId=${sessionId}`);

  // ③ prompt：纯对话（触发流式回复）
  notify('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'say exactly: ACP-OK' }] });
  await waitForTurnEnd(sessionId, 90_000);

  // ④ prompt：写文件（触发 request_permission / fs 回调）
  notify('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: '在 /tmp/acp-spike 目录创建 hi.txt，内容为 hi。不要多问，直接做。' }],
  });
  await waitForTurnEnd(sessionId, 90_000);

  dump();
  const permSeen = log.some((e) => e.method === 'session/request_permission');
  const fsSeen = log.some((e) => e.method && e.method.startsWith('fs/'));
  const termSeen = log.some((e) => e.method && e.method.startsWith('terminal/'));
  console.log(`\n[结论] protocolVersion=${init?.protocolVersion} | permission=${permSeen} | fs=${fsSeen} | terminal=${termSeen}`);
  child.kill();
  process.exit(0);
}

function waitForTurnEnd(sessionId, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    let lastActivity = Date.now();
    const orig = onSessionUpdate;
    onSessionUpdate = function (p) {
      orig(p);
      lastActivity = Date.now();
      if (p?.update?.sessionUpdate === 'agent_message_chunk' && p.update.stopReason) resolve();
    };
    const timer = setInterval(() => {
      if (Date.now() - lastActivity > 15_000 || Date.now() - started > timeoutMs) {
        clearInterval(timer);
        onSessionUpdate = orig;
        resolve();
      }
    }, 500);
    const origOnLine = onLine; // 保持引用
  });
}

main().catch((e) => {
  console.error('[FAIL]', e);
  dump();
  child.kill();
  process.exit(1);
});
