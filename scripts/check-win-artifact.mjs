#!/usr/bin/env node
/**
 * Windows 产物自检（W1a，2026-09-08 Windows 测试约定 Task 2）
 *
 * 零 wine、零运行时的**静态**门禁：把「Windows 包能不能正确做出来」里最容易漏的几项钉成机器检查。
 * 立这条的直接根因是 PACKAGING §2.3 的历史事故——Linux 打 win 包时缺
 * `@img/sharp-win32-x64`，产物照发、**Windows 端缩略图静默全废**（ensureThumbnail 只回空串，不易察觉）。
 *
 * 检查项（任一红即非零退出）：
 *   1. 主 exe 存在且体积合理（防打包半途失败留空壳）
 *   2. app.asar 文件表里三段产物齐（main / preload / renderer 入口，.js 与 .mjs 都认）
 *   3. app.asar.unpacked 里有 @img/sharp-win32-x64 且带 .node 二进制（事故点）
 *   4. Electron 运行期文件齐（ffmpeg.dll / *.pak / resources 目录）
 *   5. resources/server.json 存在且非 `{}` 占位（v2.5.2 起包内置登录地址；CI 占位属预期 → --allow-placeholder）
 *   6. asar 不比 out/ 旧（防「测的是上个版本的壳」——spike §五 的教训）
 *
 * 用法：npm run check:win-artifact [-- --dir release/win-unpacked] [--allow-placeholder] [--skip-staleness]
 * 退出码：0 全绿 / 1 有红项 / 2 前置缺失（目录或文件根本不存在）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const optVal = (name, dft) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dft
}

const targetDir = path.resolve(ROOT, optVal('dir', 'release/win-unpacked'))
const ALLOW_PLACEHOLDER = flag('allow-placeholder')
const SKIP_STALENESS = flag('skip-staleness')

const fails = []
const oks = []
const fail = (m) => fails.push(m)
const ok = (m) => oks.push(m)

/** exe 最小体积阈值：Electron 主程序本体 ~180MB（打包异常产出的空壳远小于此） */
const EXE_MIN_BYTES = 50 * 1024 * 1024

/**
 * 读 asar 头部文件名表（JSON）。
 * 实测布局（asar@v3 / electron-builder 产物）：四个 UInt32LE 长度字段后紧跟 JSON，
 * 字符串长度取 [12..15]，正文起于偏移 16。偏移不符时返回 null（调用方判红而非误判绿）。
 */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const strSize = head.readUInt32LE(12)
    if (!strSize || strSize > 64 * 1024 * 1024) return null
    const buf = Buffer.alloc(strSize)
    fs.readSync(fd, buf, 0, strSize, 16)
    const txt = buf.toString('utf8')
    if (!txt.startsWith('{')) return null
    return JSON.parse(txt)
  } catch {
    return null
  } finally {
    fs.closeSync(fd)
  }
}

/** 头部表是嵌套 {files:{名:…}} 树，路径不会以整串出现 ⇒ 必须按段遍历 */
function asarHasPath(header, segs) {
  let node = header
  for (const s of segs) {
    node = node && node.files ? node.files[s] : undefined
    if (!node) return false
  }
  return true
}

function newestMtime(dir) {
  let max = 0
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name)
      if (ent.isDirectory()) walk(abs)
      else max = Math.max(max, fs.statSync(abs).mtimeMs)
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return max
}

if (!fs.existsSync(targetDir)) {
  console.error(
    `[check:win-artifact] 产物目录不存在：${path.relative(ROOT, targetDir)}\n` +
      '  先出包：npm run build && npx electron-builder --win dir --publish never -c.win.signAndEditExecutable=false',
  )
  process.exit(2)
}

const rel = (p) => path.relative(ROOT, p)

// 1. 主 exe
const exes = fs.readdirSync(targetDir).filter((f) => f.toLowerCase().endsWith('.exe'))
if (!exes.length) fail(`目录里没有 exe：${rel(targetDir)}`)
for (const e of exes) {
  const st = fs.statSync(path.join(targetDir, e))
  if (st.size < EXE_MIN_BYTES) fail(`${e} 体积异常（${(st.size / 1024 / 1024).toFixed(1)}MB < 50MB），疑打包未完成`)
  else ok(`${e} ${(st.size / 1024 / 1024).toFixed(0)}MB`)
}

// 2. asar 内容表含 main
const asarPath = path.join(targetDir, 'resources', 'app.asar')
if (!fs.existsSync(asarPath)) {
  fail('缺 resources/app.asar')
} else {
  const header = readAsarHeader(asarPath)
  // 入口扩展名随 module 形态变（package.json type=module ⇒ preload 出 .mjs），两种都要认
  const hasEntry = (dir) => asarHasPath(header, ['out', dir, 'index.js']) || asarHasPath(header, ['out', dir, 'index.mjs'])
  if (header === null) fail('app.asar 头部解析失败（格式非预期，勿据此判绿）')
  else if (!hasEntry('main')) fail('app.asar 内没有 out/main/index.(js|mjs)（主进程未进包）')
  else if (!hasEntry('preload')) fail('app.asar 内没有 out/preload/index.(js|mjs)（预加载未进包 ⇒ 渲染层拿不到 window.qihebox）')
  else if (!asarHasPath(header, ['out', 'renderer', 'index.html'])) fail('app.asar 内没有 out/renderer/index.html（渲染层未进包）')
  else ok('app.asar 三段产物齐（main / preload / renderer）')
  // 6. 新鲜度：asar 必须不早于 out/ 里最新产物
  if (!SKIP_STALENESS) {
    const outDir = path.join(ROOT, 'out')
    if (fs.existsSync(outDir)) {
      const asarM = fs.statSync(asarPath).mtimeMs
      const outM = newestMtime(outDir)
      if (outM > asarM) {
        fail(
          `app.asar 比 out/ 旧（asar ${new Date(asarM).toISOString()} < out ${new Date(outM).toISOString()}）` +
            ' ⇒ 产物是上一次构建的壳，先重跑打包；确要跳过用 --skip-staleness',
        )
      } else ok('app.asar 不早于 out/ 构建时间')
    }
  }
}

// 3. sharp win32 二进制（事故点）
const unpacked = path.join(targetDir, 'resources', 'app.asar.unpacked', 'node_modules')
const imgDir = path.join(unpacked, '@img')
if (!fs.existsSync(imgDir)) {
  fail('缺 app.asar.unpacked/node_modules/@img（sharp 原生二进制未解包）')
} else {
  const winDirs = fs.readdirSync(imgDir).filter((d) => /^sharp-win32-x64/.test(d))
  if (!winDirs.length) {
    fail(
      `缺 @img/sharp-win32-x64（现有：${fs.readdirSync(imgDir).join(', ')}）` +
        ' ⇒ Windows 端缩略图会静默全废（PACKAGING §2.3）；补装：npm i -D @img/sharp-win32-x64@<与 sharp 同版本>',
    )
  } else {
    const walkNode = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const abs = path.join(d, ent.name)
        if (ent.isDirectory()) {
          const r = walkNode(abs)
          if (r) return r
        } else if (ent.name.endsWith('.node')) return abs
      }
      return null
    }
    const node = walkNode(path.join(imgDir, winDirs[0]))
    if (!node) fail(`${winDirs[0]} 里没有 .node 二进制`)
    else ok(`sharp win32 二进制在位：${path.relative(targetDir, node)}`)
  }
  if (!fs.existsSync(path.join(unpacked, 'sharp'))) fail('sharp 主包未解包（asarUnpack 配了但产物缺）')
}

// 4. Electron 运行期文件
for (const f of ['ffmpeg.dll', 'libEGL.dll', 'libGLESv2.dll', 'resources.pak', 'icudtl.dat']) {
  if (!fs.existsSync(path.join(targetDir, f))) fail(`缺 ${f}`)
}
if (!fs.existsSync(path.join(targetDir, 'locales'))) fail('缺 locales/（electronLanguages 配置异常）')
else ok(`locales ${fs.readdirSync(path.join(targetDir, 'locales')).length} 项`)

// 5. 包内置登录地址
const serverJson = path.join(targetDir, 'resources', 'server.json')
if (!fs.existsSync(serverJson)) {
  fail('缺 resources/server.json（extraResources 未生效 ⇒ 装好的包登录地址为空）')
} else {
  const txt = fs.readFileSync(serverJson, 'utf8').trim()
  const placeholder = !txt || txt === '{}' || !/https?:\/\//.test(txt)
  if (placeholder && !ALLOW_PLACEHOLDER) {
    fail(`server.json 是占位（${txt || '空'}）⇒ 对外发布的包必须注入真实地址（内部发布手册 ③ 前置）；CI 占位包用 --allow-placeholder`)
  } else if (placeholder) ok('server.json 占位（CI 包，已 --allow-placeholder 放行）')
  else ok('server.json 含真实服务地址')
}

for (const m of oks) console.log(`  ✓ ${m}`)
if (fails.length) {
  console.error(`\n[check:win-artifact] 红 ${fails.length} 项：`)
  for (const m of fails) console.error(`  ✗ ${m}`)
  process.exit(1)
}
console.log(`[check:win-artifact] 绿（${oks.length} 项全过）：${rel(targetDir)}`)
