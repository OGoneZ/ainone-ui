#!/usr/bin/env node
/**
 * prepare-runtime.mjs —— 内嵌 bun 二进制的下载/校验/落位（P31）。
 *
 * CI（release.yml 矩阵腿）与本地打包前各跑一次：
 *   node scripts/prepare-runtime.mjs [--target <triple>]
 *
 * 流程：
 *   1. 读 src-tauri/resources/runtime-versions.json（版本 + 各 target sha256）
 *   2. 下载 https://github.com/oven-sh/bun/releases/download/bun-v{ver}/{filename}
 *   3. sha256 与清单比对（node:crypto）——不符删除临时文件 exit 1
 *   4. 解压（macOS/Linux unzip；Windows PowerShell Expand-Archive——runner 自带）
 *   5. 取出可执行文件落位 src-tauri/resources/runtime/{target}/bun（.exe）
 *   6. 幂等：目标已存在且 sha256 匹配 → 跳过
 *
 * 设计红线：校验失败绝不落位（宁可打包失败，不上未验证的二进制）。
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(repoRoot, 'src-tauri', 'resources', 'runtime-versions.json')
const outputRoot = path.join(repoRoot, 'src-tauri', 'resources', 'runtime')

const BUN_RELEASE_BASE = 'https://github.com/oven-sh/bun/releases/download'

// rustc triple → bun release 资产名里的平台段（与 runtime-versions.json filename 一致）
const TRIPLE_TO_BUN_TARGET = {
  'aarch64-apple-darwin': 'darwin-aarch64',
  'x86_64-apple-darwin': 'darwin-x64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'x86_64-pc-windows-msvc': 'windows-x64',
}

function loadManifest() {
  const raw = fs.readFileSync(manifestPath, 'utf8')
  const m = JSON.parse(raw)
  if (m.schemaVersion !== 1) throw new Error(`不支持的 schemaVersion: ${m.schemaVersion}`)
  if (typeof m.bun !== 'string' || !m.bun.trim()) throw new Error('清单缺 bun 版本')
  if (!m.bunArtifacts || typeof m.bunArtifacts !== 'object') throw new Error('清单缺 bunArtifacts')
  return m
}

function currentTriple() {
  // 与 build.rs 的 TARGET/HOST 同源：本地构建取宿主，交叉由 --target 显式给
  const plat = process.platform
  const arch = process.arch
  if (plat === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin'
  if (plat === 'linux') return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu'
  if (plat === 'win32') return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  throw new Error(`不支持的平台: ${plat}`)
}

function parseArgs(argv) {
  let target = null
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') {
      target = argv[i + 1]
      if (!target) throw new Error('--target 缺值')
      i++
    } else if (argv[i].startsWith('--target=')) {
      target = argv[i].slice('--target='.length)
    } else {
      throw new Error(`未知参数: ${argv[i]}`)
    }
  }
  return { target: target || currentTriple() }
}

function sha256File(file) {
  const h = createHash('sha256')
  h.update(fs.readFileSync(file))
  return h.digest('hex')
}

function download(url, dest) {
  // node 18+ 原生 fetch（CI runner 与本机均满足）；GitHub release 302 → fetch 自动跟随
  return fetch(url, { redirect: 'follow' }).then(async (res) => {
    if (!res.ok) throw new Error(`下载失败 ${res.status} ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(dest, buf)
    return buf.length
  })
}

function extractZip(zip, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destDir}' -Force`,
    ], { stdio: 'inherit' })
  } else {
    execFileSync('unzip', ['-o', '-q', zip, '-d', destDir], { stdio: 'inherit' })
  }
}

/** 在解压目录里找 bun 可执行文件（官方 zip 布局 bun-v{ver}/bun 或平铺 bun） */
function findBunBinary(extractDir) {
  const name = process.platform === 'win32' ? 'bun.exe' : 'bun'
  const stack = [extractDir]
  while (stack.length) {
    const dir = stack.pop()
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name === name) return p
    }
  }
  return null
}

async function main() {
  const { target } = parseArgs(process.argv.slice(2))
  const bunPlatform = TRIPLE_TO_BUN_TARGET[target]
  if (!bunPlatform) {
    throw new Error(`target ${target} 无对应 bun 资产映射（TRIPLE_TO_BUN_TARGET）`)
  }
  const manifest = loadManifest()
  const entry = manifest.bunArtifacts[target]
  if (!entry || !entry.filename) throw new Error(`清单缺 ${target} 的 filename`)
  if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
    throw new Error(`清单 ${target} 的 sha256 非法（须 64 位 hex；PENDING 占位须先由首跑回填）`)
  }

  const outDir = path.join(outputRoot, target)
  const outFile = path.join(outDir, process.platform === 'win32' && target.startsWith('x86_64-pc-windows') ? 'bun.exe' : 'bun')

  // 幂等：已落位且哈希匹配 → 跳过
  if (fs.existsSync(outFile) && sha256File(outFile) === entry.sha256) {
    console.log(`[prepare-runtime] skip: ${outFile} 已存在且 sha256 匹配`)
    return
  }
  // 幂等前的来源甄别：文件已在但非本次下载（如交叉 target 的残留）也走全量下载，
  // 哈希对不上时在落位前拦截（下方 sha 校验），绝不覆盖成坏文件。

  const url = `${BUN_RELEASE_BASE}/bun-v${manifest.bun}/${entry.filename}`
  const staging = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ainone-bun-'))
  const zipPath = path.join(staging, entry.filename)
  try {
    console.log(`[prepare-runtime] 下载 ${url}`)
    const bytes = await download(url, zipPath)
    const actual = sha256File(zipPath)
    if (actual !== entry.sha256) {
      fs.rmSync(zipPath, { force: true })
      throw new Error(`sha256 不符：期望 ${entry.sha256}，实际 ${actual}（已删除下载文件）`)
    }
    console.log(`[prepare-runtime] sha256 校验通过（${(bytes / 1048576).toFixed(1)} MB）`)

    const extractDir = path.join(staging, 'extract')
    extractZip(zipPath, extractDir)
    const binary = findBunBinary(extractDir)
    if (!binary) throw new Error(`解压产物中未找到 bun 可执行文件（${extractDir}）`)

    fs.mkdirSync(outDir, { recursive: true })
    fs.copyFileSync(binary, outFile)
    if (process.platform !== 'win32') fs.chmodSync(outFile, 0o755)
    console.log(`[prepare-runtime] 落位 ${outFile}`)
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(`[prepare-runtime] ${e.message}`)
  process.exit(1)
})
