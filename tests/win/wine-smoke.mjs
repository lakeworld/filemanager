/**
 * Windows/wine 运行时冒烟驱动（W1b，2026-09-08 Windows 测试约定 Task 3）
 *
 * 在 qihe-win 容器里用 wine 真跑**本次构建**的 Windows 产物，走一遍「Windows 环境下的使用」：
 * 建工作区（C:\ 路径）→ 产品集与中文子文件夹 → 走应用导入管道归档 → sharp 缩略图 → 元数据打标
 * → 重命名/移动 → 笔记原子写（含覆盖写）→ 同内容证书硬链接去重巡检 → 回收站往返 → 搜索/计数
 * → 剪贴板与资源管理器通道 → 主日志体检。
 *
 * 为什么不能复用现成 e2e：Playwright 的 `_electron.launch` 驱动不了 wine 里的 .exe（它要接管应用内嵌
 * Node），只能「打包产物 + --remote-debugging-port + connectOverCDP」（内部 spike 记录 §一）。
 *
 * 判定纪律（防假绿灯，spike §三）：
 *   - 视觉只取证不判绿：wine 缺 emoji 字体时 Chromium 字形宽度回退 32768px 会挤坏排版 ⇒ 截图仅归档。
 *   - open.ts 的 win32 分支被 QIHEBOX_E2E 短路 ⇒ 不断言「用默认应用打开文件」（划入真机清单）。
 *   - explorer.ts 把「外部命令超时」当成功放行 ⇒ showFilesInExplorer 只断言不抛错。
 *   - 硬链接走容器 ext4，NTFS 硬链接限制（同卷/上限）不可证 ⇒ 真机清单。
 *   - 台账探针（CON 文件夹名、字形宽度）为 soft 诊断：报出不判红，避免把已知台账变成常红灯。
 *
 * 用法（容器内由 qihe-docker/win-test.sh 拉起；宿主侧走 box 仓 `npm run test:win`）：
 *   xvfb-run -a node tests/win/wine-smoke.mjs [--keep-app] [--artifacts <dir>]
 * 退出码：0 全绿 / 1 有红项 / 2 前置缺失（产物、wine 前缀或依赖不在）
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const KEEP_APP = argv.includes('--keep-app')
const artIdx = argv.indexOf('--artifacts')
const ARTIFACTS = path.resolve(ROOT, artIdx >= 0 && argv[artIdx + 1] ? argv[artIdx + 1] : 'docs/INTERNAL/assets/win-smoke/latest')

const PREFIX = process.env.WINEPREFIX || '/wine/prefix'
const DRIVE_C = path.join(PREFIX, 'drive_c')
const APP_SRC = path.join(ROOT, 'release', 'win-unpacked')
const APP_RUN = '/tmp/win-smoke/app' // ASCII 路径（坚果云中文路径是 PACKAGING §七 已知坑）
const WIN_APP = 'Z:\\' + APP_RUN.slice(1).split('/').join('\\') // 同一目录的 wine 视角（Z: = 容器根）
const USERDATA = 'qihebox-win-smoke' // wine 下 os.tmpdir() = 前缀内 C:\users\<u>\AppData\Local\Temp
const WIN_WS = 'C:\\qihe-win-smoke\\ws' // 工作区（Windows 形状，与真机同款）
const WIN_SRC = 'C:\\qihe-win-smoke\\src' // 导入源（先由容器侧写进前缀，再按 C:\ 引用）
const CDP_TIMEOUT_MS = Number(process.env.WIN_SMOKE_CDP_TIMEOUT || 180_000)
const CDP_CONNECT_TIMEOUT_MS = Number(process.env.WIN_SMOKE_CONNECT_TIMEOUT || 90_000)
const CDP_CONNECT_ATTEMPTS = Number(process.env.WIN_SMOKE_CONNECT_ATTEMPTS || 4)
const STEP_TIMEOUT_MS = Number(process.env.WIN_SMOKE_STEP_TIMEOUT || 40_000)

// —— 渲染层事件汇聚（导入是**异步**：IPC 立即返回，结果走 import:complete 事件，files.ts:350）——
const EV_INSTALL = () => {
  window.__ev = { import: [] }
  window.qihebox.events.on('import:complete', (d) => window.__ev.import.push(d))
}
/** 等到第 n 条 import:complete（n 从 0 起），返回事件负载 */
async function waitImportComplete(page, n) {
  const ev = await until(
    () => page.evaluate((i) => (window.__ev && window.__ev.import && window.__ev.import[i]) || null, n),
    `第 ${n + 1} 个 import:complete 事件`,
  )
  if (ev.success === false) throw new Error(`导入失败：${ev.error} · failed=${JSON.stringify(ev.failed || []).slice(0, 200)}`)
  return ev
}

/** Windows 绝对路径（C:\…）→ 容器内可见路径，用于直接查磁盘证据 */
const toLinux = (winPath) => path.join(DRIVE_C, winPath.replace(/^[A-Za-z]:\\/, '').replace(/\\/g, '/'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
let failed = 0
let softened = 0
const report = []
async function step(name, fn, kind = 'hard') {
  const t0 = Date.now()
  try {
    const note = (await fn()) || ''
    passed++
    report.push({ name, ok: true, kind, ms: Date.now() - t0, note })
    console.log(`  ✓ ${name}${note ? ' — ' + note : ''}`)
  } catch (e) {
    const ms = Date.now() - t0
    const msg = String((e && e.message) || e)
    if (kind === 'soft') {
      softened++
      passed++
      report.push({ name, ok: true, kind, ms, note: '诊断：' + msg })
      console.log(`  ◦ ${name} — 诊断（不判红）：${msg}`)
    } else {
      failed++
      report.push({ name, ok: false, kind, ms, note: msg })
      console.error(`  ✗ ${name} — ${msg}`)
    }
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg)
}
async function until(fn, what, timeoutMs = STEP_TIMEOUT_MS, everyMs = 400, onTick) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    const ms = Date.now() - t0
    // what 允许是函数：超时文案要在**超时的当下**取最近错误，快照成字符串就永远是「无」
    const label = typeof what === 'function' ? what() : what
    if (ms > timeoutMs) throw new Error(`超时 ${timeoutMs}ms 未等到：${label}`)
    if (onTick && ms - (onTick.last || 0) >= 15_000) {
      onTick.last = ms
      onTick(ms)
    }
    await sleep(everyMs)
  }
}
/** 渲染层调用统一包一层：拿 IPC 的 {success,data,error} 形状，失败即抛 */
const call = (page, fn, arg) =>
  page.evaluate(fn, arg).then((r) => {
    if (r && r.success === false) throw new Error(String(r.error || 'IPC 返回 success=false'))
    return r
  })
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

/** 工作区相对路径（正斜杠口径）→ Windows 绝对路径（反斜杠），别用宿主 path.join 拼 */
const winAbs = (rel) => path.win32.join(WIN_WS, ...rel.split('/'))

/** 前缀内可能有多个用户目录（root/lake/Public…），按 userData 名定位真实所在，别拿 readdir[0] 撞运气 */
function findUserData(name) {
  const usersRoot = path.join(DRIVE_C, 'users')
  if (!fs.existsSync(usersRoot)) return { home: '', dir: '', logs: '' }
  for (const u of fs.readdirSync(usersRoot)) {
    const base = path.join(usersRoot, u, 'AppData', 'Local', 'Temp', name)
    if (fs.existsSync(base)) return { home: base, logs: path.join(base, 'logs') }
  }
  return { home: '', logs: '' }
}

/** 起包是否成功（失败则后续 CDP 相关步骤整体跳过，不裸崩） */
let appUp = false

fs.mkdirSync(ARTIFACTS, { recursive: true })
console.log(`[win-smoke] wine 冒烟开始 · 前缀 ${PREFIX} · 证据 ${path.relative(ROOT, ARTIFACTS)}`)

// —— 前置 ——
if (!fs.existsSync(APP_SRC)) {
  console.error(
    `[win-smoke] 缺 Windows 产物：${path.relative(ROOT, APP_SRC)}\n` +
      '  先出包：npm run build && npx electron-builder --win dir --publish never -c.win.signAndEditExecutable=false',
  )
  process.exit(2)
}
let chromium
try {
  ;({ chromium } = require('@playwright/test'))
} catch {
  console.error('[win-smoke] 容器内解析不到 @playwright/test（node_modules 卷未装依赖？win-test.sh 会自动 npm ci）')
  process.exit(2)
}

const t0 = Date.now()

// 1) W1a 产物自检先过（红就不必起 wine）
await step('W1a 产物自检（check:win-artifact）', async () => {
  const r = spawnSync(process.execPath, ['scripts/check-win-artifact.mjs'], { cwd: ROOT, encoding: 'utf8' })
  assert(r.status === 0, (r.stdout + r.stderr).trim().split('\n').slice(-4).join(' / '))
  return '绿'
})

// 2) 运行副本（ASCII 路径 + 中文名 exe 保持原样，真机同名）
let exeWin = ''
let exeOriginal = ''
await step('准备运行副本（release/win-unpacked → /tmp/win-smoke/app）', async () => {
  spawnSync('rm', ['-rf', APP_RUN])
  fs.mkdirSync(path.dirname(APP_RUN), { recursive: true })
  const r = spawnSync('cp', ['-a', APP_SRC, APP_RUN], { encoding: 'utf8' })
  assert(r.status === 0, 'cp 失败：' + r.stderr)
  const exe = fs.readdirSync(APP_RUN).find((f) => f.toLowerCase().endsWith('.exe'))
  assert(exe, '运行副本里没有 exe')
  exeOriginal = exe
  // wine 11 容器实测：以**非 ASCII 文件名**启动 exe 直接 `wine: failed to open`（宿主 deepin-wine 10.14 可以）。
  // 冒烟用 ASCII 名副本——只改文件名，包内 productName 不变（UA 仍是「启禾文件管理/2.5.7」，
  // userData 与单实例锁按 app 名走，不受影响）。「中文 exe 名双击启动」这一面归 W2 真机清单。
  const asciiExe = 'qihebox-smoke.exe'
  if (exe !== asciiExe) fs.renameSync(path.join(APP_RUN, exe), path.join(APP_RUN, asciiExe))
  // 用「cwd + 相对名」起包：与手工验过的启动形式保持一致。
  // 绝对 Z:\ 形式虽也能拉起进程，但实测 CDP 端口要 2 分多才绑定（相对路径约 6 秒），排查成本高。
  exeWin = './' + asciiExe // POSIX 形状：wine 两版都吃（宿主 10.14 实测），`.\` 形式未在真机验过
  return `${exe} → ${asciiExe}（wine 侧 ASCII 名，原因见脚本头注释）`
})

// 3) 前缀就绪（win-test.sh 已 wineboot；此处兜底，缺 drive_c 就是挂载没对上）
await step('wine 前缀就绪', async () => {
  // 判据用 kernel32.dll 而非 windows/ 目录：半初始化的前缀也有 windows/ 目录（run-in-container 的教训）
  if (fs.existsSync(path.join(DRIVE_C, 'windows', 'system32', 'kernel32.dll'))) return '复用卷'
  const r = spawnSync('wineboot', ['--init'], { encoding: 'utf8', timeout: 300_000, env: process.env })
  assert(r.status === 0, 'wineboot 失败：' + (r.stderr || r.stdout).slice(0, 200))
  return '本次新建'
})

// 3b) 清掉上一轮的残留状态（前缀是命名卷，跨轮复用 ⇒ 不清就会拿脏数据判绿/判红）
//     工作区、导入源、userData（含单实例锁与主日志）全部归零，让每一轮都是冷启。
await step('清残留状态（工作区 / 导入源 / userData）', async () => {
  const targets = [toLinux(WIN_WS), toLinux(WIN_SRC)]
  const tmpRoot = path.join(DRIVE_C, 'users')
  if (fs.existsSync(tmpRoot)) {
    for (const u of fs.readdirSync(tmpRoot)) targets.push(path.join(tmpRoot, u, 'AppData', 'Local', 'Temp', USERDATA))
  }
  let n = 0
  for (const t of targets) {
    if (!fs.existsSync(t)) continue
    fs.rmSync(t, { recursive: true, force: true })
    n++
  }
  assert(targets.every((t) => !fs.existsSync(t)), '有残留目录删不掉：' + targets.filter((t) => fs.existsSync(t)).join(' '))
  return n ? `删掉 ${n} 处` : '本来就干净'
})

// 4) 起包 + CDP
const port = await freePort()
const appLog = path.join(ARTIFACTS, 'app-stdout.log')
let child = null
/** wine 进程是否还活着（子进程是 detached 进程组，用 kill -0 探组） */
function wineAlive() {
  if (!child || !child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch {
    return false
  }
}
/**
 * 从 wine 的 stdout 里取 DevTools 的 ws 端点。
 *
 * 为什么不走 /json/version：wine 11 下 Chromium 的 DevTools **HTTP** 取址不可靠——同一端口上
 * HTTP/1.0 请求会被回 `Cannot handle request with protocol: HTTP/1.0`（说明连接与解析都活着），
 * 但 HTTP/1.1 的 GET 一个字节都不回（实测 2026-09-08：裸 socket / fetch / node http / curl 全部挂到超时，
 * 而应用**冷启**时裸 socket 1.0s 能拿到 590 字节）。差异来自应用启动后的状态（重建索引/恢复工作区），
 * 不可控。而 Electron 一定会把 `DevTools listening on ws://…` 打到 stdout——这是权威来源，
 * 直接把 ws 端点交给 connectOverCDP，跳过那一次会挂的 HTTP（playwright 支持传 ws:// 地址）。
 */
function cdpWsFromLog(logText, port) {
  const m = /DevTools listening on (ws:\/\/[^\s]+)\s*$/m.exec(logText)
  if (!m) return ''
  if (!m[1].includes(`:${port}/`)) return '' // 端口不是我们要的那个（别的实例），继续等
  return m[1]
}

/** DevTools 的 ws 端点（从 wine stdout 取，原因见 cdpWsFromLog 注释） */
let cdpWs = ''
await step('起 Windows 包（wine + CDP 端口）', async () => {
  const out = fs.openSync(appLog, 'w')
  child = spawn(
    'wine',
    [exeWin, '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, '--remote-allow-origins=*'],
    {
      cwd: APP_RUN,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_USERDATA: USERDATA,
        DISPLAY: process.env.DISPLAY || ':99',
      },
      stdio: ['ignore', out, out],
      detached: true,
    },
  )
  child.on('error', (e) => console.error('[win-smoke] wine 启动失败：', e.message))
  const readLog = () => (fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8') : '')
  cdpWs = await until(
    () => cdpWsFromLog(readLog(), port),
    () => `wine stdout 里的 "DevTools listening on ws://…:${port}"（wine 进程 ${wineAlive() ? '存活' : '已退出'}；输出见 ${path.relative(ROOT, appLog)}）`,
    CDP_TIMEOUT_MS,
    500,
    (ms) =>
      console.log(
        `      …等 CDP 就绪 ${Math.round(ms / 1000)}s · wine 进程 ${wineAlive() ? '存活' : '已退出'}` +
          ` · DevTools 行 ${readLog().includes('DevTools listening') ? '已出现（端口不符？看 wine 输出）' : '未出现'}`,
      ),
  )
  appUp = true
  return cdpWs.replace(/^ws:\/\/[^/]+\//, 'ws://…/')
})

// 起包失败就没必要往下连（连不上会抛裸异常把报告吞掉）：直接把 wine 输出摊出来再收口
if (!appUp) {
  const tail = fs.existsSync(appLog) ? fs.readFileSync(appLog, 'utf8').split('\n').slice(-12).join('\n') : '（无输出）'
  console.error(`\n[win-smoke] Windows 包未能启动，wine 输出尾部：\n${tail}`)
  killApp()
  finishAndExit()
}

// 连接走 ws 端点：connectOverCDP 传 http 地址时它内部那次 /json/version 取址在 wine 下不可靠
// （原因见 cdpWsFromLog 注释），所以把已经从 stdout 拿到的 ws 端点直接喂给它。
// 仍保留重试：应用忙（建索引/首屏）时 ws 握手偶发失败。
let browser = null
let connErr = ''
for (let i = 1; i <= CDP_CONNECT_ATTEMPTS && !browser; i++) {
  try {
    browser = await chromium.connectOverCDP(cdpWs, { timeout: CDP_CONNECT_TIMEOUT_MS })
  } catch (e) {
    connErr = String((e && e.message) || e).split('\n')[0]
    console.log(`      connectOverCDP 第 ${i}/${CDP_CONNECT_ATTEMPTS} 次失败：${connErr}`)
    await sleep(3000)
  }
}
if (!browser) {
  // 假绿守卫（v2.5.8 实测暴露，2026-09-08）：起包步骤成功（stdout 有 ws 端点）但 CDP 一条都没连上时，
  // 下面整条 Windows 使用链根本没执行过，而旧写法直接 finishAndExit() ⇒ 报告里 failed=0 → 打印「结论：绿 · 退出 0」。
  // Docker 形态（DevTools 在容器命名空间里不回包）每次都走这条路径，等于门禁长期假装在测。
  // 这里显式记一条硬失败：验不到 = 红，不是绿。
  failed++
  report.push({
    name: '连上 DevTools（CDP）',
    ok: false,
    kind: 'hard',
    ms: 0,
    note: `connectOverCDP ${CDP_CONNECT_ATTEMPTS} 次均失败（末次：${connErr}）——Windows 使用链一项未验`,
  })
  console.error(`\n[win-smoke] CDP 连不上（末次错误：${connErr}）`)
  killApp()
  finishAndExit()
}
const page = browser.contexts()[0].pages()[0]
await page.waitForFunction(() => !!window.qihebox, null, { timeout: 30_000 }).catch(() => {})
// 事件汇聚要在任何导入动作之前装好（装晚了事件就丢了）
await page.evaluate(EV_INSTALL)

await step('窗口与渲染层就位', async () => {
  const info = await page.evaluate(() => ({
    title: document.title,
    w: innerWidth,
    h: innerHeight,
    platform: navigator.platform,
    ua: navigator.userAgent,
    hasBox: !!window.qihebox,
    url: location.href,
  }))
  assert(info.hasBox, 'window.qihebox 未暴露（preload 没进包或注入失败）')
  // 这两条是「真在 Windows 运行时里」的核心证据（原来靠 /json/version 的 UA，改从渲染层取）
  assert(info.platform === 'Win32', `navigator.platform=${info.platform}，不是 Windows 运行时`)
  assert(/Windows NT/i.test(info.ua), `userAgent 不含 Windows NT：${info.ua}`)
  assert(info.w >= 1024 && info.h >= 720, `窗口 ${info.w}x${info.h} 小于 1024x720 最小布局`)
  assert(info.url.includes('app.asar'), `页面未从包内加载：${info.url}`)
  return `${info.title} ${info.w}x${info.h} · ${info.platform} · asar 内加载 · UA=${info.ua}`
})

await step('宿主 API 面关键域齐全', async () => {
  const keys = await page.evaluate(() => Object.keys(window.qihebox))
  const need = ['workspace', 'productSets', 'files', 'dirs', 'metadata', 'trash', 'search', 'dashboard', 'window']
  const miss = need.filter((k) => !keys.includes(k))
  assert(miss.length === 0, `缺域：${miss.join(',')}（实得 ${keys.length} 域）`)
  return `${keys.length} 域`
})

// userData 隔离自校验（spike §三.4：旧产物会忽略 QIHEBOX_E2E_USERDATA 回落共享名 ⇒ 必须实测）
await step('userData 隔离生效（logs 落在独立目录）', async () => {
  const d = await until(() => {
    if (!fs.existsSync(path.join(DRIVE_C, 'users'))) return null
    for (const u of fs.readdirSync(path.join(DRIVE_C, 'users'))) {
      const dir = path.join(DRIVE_C, 'users', u, 'AppData', 'Local', 'Temp', USERDATA, 'logs')
      if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.log'))) return dir
    }
    return null
  }, `前缀内 */Temp/${USERDATA}/logs（QIHEBOX_E2E_USERDATA 被认账）`, 40_000)
  return path.relative(DRIVE_C, d)
})

// —— Windows 环境下的使用链 ——
await step('建工作区于 C:\\ 并列出内建目录', async () => {
  const r = await call(page, async (p) => await window.qihebox.workspace.create(p), WIN_WS)
  assert(r.data && r.data.path, `workspace.create 无返回路径：${JSON.stringify(r)}`)
  const list = await call(page, async (d) => await window.qihebox.dirs.list(d), r.data.path)
  const want = ['产品集', '图包', '证书', '导出', '客户', '发票', '入库', '交换区', '供应商', '报价']
  const got = list.data.dirs || []
  const miss = want.filter((d) => !got.includes(d))
  assert(miss.length === 0, `内建目录缺失：${miss.join(',')}（实得 ${got.length} 个）`)
  assert(fs.existsSync(path.join(toLinux(WIN_WS), '.qihefilemanager')), '.qihefilemanager 没落在 C: 工作区下')
  return `${r.data.path} · ${got.length} 个内建目录`
})

await step('新建产品集 + 中文子文件夹（真实落盘）', async () => {
  await call(page, async () => await window.qihebox.productSets.create({ name: '冒烟产品集' }))
  await call(
    page,
    async () =>
      await window.qihebox.files.createSubfolder({ product_set: '冒烟产品集', file_type: 'image', name: '白底图-冒烟' }),
  )
  // 落点口径见 files.ts:targetDir —— 图包在产品集域下：产品集\<集>\图包\<子文件夹>
  const d = path.join(toLinux(WIN_WS), '产品集', '冒烟产品集', '图包', '白底图-冒烟')
  assert(fs.existsSync(d), `子文件夹未真落在 Windows 路径：${d}`)
  return '产品集\\冒烟产品集\\图包\\白底图-冒烟'
})

await step('准备导入源文件（两张同内容图 + 两张同内容证书）', async () => {
  const srcDir = toLinux(WIN_SRC)
  fs.mkdirSync(srcDir, { recursive: true })
  const icon = path.join(ROOT, 'build', 'appicon.png')
  assert(fs.existsSync(icon), `缺样本图 ${path.relative(ROOT, icon)}`)
  const png = fs.readFileSync(icon)
  for (const n of ['主图 A.png', '主图 B.png', '质检报告.pdf', '质检报告-副本.pdf']) fs.writeFileSync(path.join(srcDir, n), png)
  return `4 个文件写在 ${WIN_SRC}`
})

let imgA = ''
let imgB = ''
let importEvents = 0 // 已消费的 import:complete 序号
await step('走应用导入管道归档两张图（进索引才算导入）', async () => {
  const r = await call(
    page,
    async (src) =>
      await window.qihebox.files.import({
        source_paths: [src + '\\主图 A.png', src + '\\主图 B.png'],
        target_product_set: '冒烟产品集',
        target_type: 'image',
        sub_folder: '主图',
      }),
    WIN_SRC,
  )
  void r // files:import 立即返回（异步管道），结果看事件
  const ev = await waitImportComplete(page, importEvents++)
  assert(ev.count === 2, `导入完成事件 count=${ev.count}（应 2）：${JSON.stringify(ev).slice(0, 200)}`)
  const dir = path.join(toLinux(WIN_WS), '产品集', '冒烟产品集', '图包', '主图')
  const names = fs.readdirSync(dir).filter((f) => !f.startsWith('.'))
  assert(names.length === 2, `导入落盘 ${names.length} 个文件（应 2）：${names.join(', ')}`)
  const sorted = names.map((f) => path.win32.join(WIN_WS, '产品集', '冒烟产品集', '图包', '主图', f)).sort()
  imgA = sorted[0]
  imgB = sorted[1]
  assert(/^C:\\/.test(imgA), `导入后路径不是 Windows 形状：${imgA}`)
  for (const p of [imgA, imgB]) assert(fs.existsSync(toLinux(p)), `导入产物不在磁盘：${p}`)
  return `2 张 · ${path.win32.basename(imgA)} / ${path.win32.basename(imgB)}（事件 count=${ev.count}）`
})

await step('缩略图真出文件（sharp-win32 原生二进制）', async () => {
  const r = await call(page, async (p) => await window.qihebox.files.thumbnailUrl(p), imgA)
  assert(typeof r.data === 'string' && r.data.startsWith('qihebox://thumb/'), `返回非 thumb URL：${r.data}`)
  const ud = findUserData(USERDATA)
  assert(ud.home, `找不到 userData 目录（${USERDATA}）`)
  const thumbRoot = path.join(ud.home, 'thumbs')
  const found = await until(
    () => {
      if (!fs.existsSync(thumbRoot)) return null
      const stack = [thumbRoot]
      while (stack.length) {
        const d = stack.pop()
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const abs = path.join(d, ent.name)
          if (ent.isDirectory()) stack.push(abs)
          else if (ent.name.endsWith('.thumb.jpg') && fs.statSync(abs).size > 500) return abs
        }
      }
      return null
    },
    'userData/thumbs 下出现非空 .thumb.jpg',
    30_000,
    300,
  )
  return `${path.basename(found)} ${fs.statSync(found).size}B（PACKAGING §2.3 事故点）`
})

await step('元数据打标 + 读回（按绝对路径推 key）', async () => {
  await call(
    page,
    async (p) => await window.qihebox.metadata.update({ file_path: p, notes: 'wine 冒烟备注' }),
    imgA,
  )
  const g = await call(page, async (p) => await window.qihebox.metadata.get(p), imgA)
  assert(g.data && g.data.notes === 'wine 冒烟备注', `读回不符：${JSON.stringify(g.data).slice(0, 160)}`)
  return 'notes 读写一致'
})

await step('重命名：非法字符必须被拒、中文名必须落地', async () => {
  const bad = await page.evaluate(async (p) => await window.qihebox.files.rename({ path: p, newName: 'a|b.png' }), imgB)
  assert(bad.success === false, `非法字符名竟然改成功（Windows 侧会建出畸形文件）：${JSON.stringify(bad)}`)
  await call(page, async (p) => await window.qihebox.files.rename({ path: p, newName: '主图B-改名.png' }), imgB)
  const newName = path.win32.join(path.win32.dirname(imgB), '主图B-改名.png')
  assert(fs.existsSync(toLinux(newName)), `改名后文件不在原 Windows 目录：${newName}`)
  imgB = newName
  return '拒绝 a|b.png + 中文名改名落地'
})

await step('移动到子文件夹（结构化目标，后端拼路径）', async () => {
  await call(
    page,
    async (p) =>
      await window.qihebox.files.move({ paths: [p], target_product_set: '冒烟产品集', target_type: 'image', sub_folder: '白底图-冒烟' }),
    imgB,
  )
  const landed = path.join(toLinux(WIN_WS), '产品集', '冒烟产品集', '图包', '白底图-冒烟', '主图B-改名.png')
  await until(() => (fs.existsSync(landed) ? true : null), '文件落到新的 Windows 路径')
  imgB = path.win32.join(WIN_WS, '产品集', '冒烟产品集', '图包', '白底图-冒烟', '主图B-改名.png')
  return '图包/冒烟产品集/白底图-冒烟'
})

await step('笔记：工作区相对路径原子写 + 覆盖写 + 读回', async () => {
  const rel = '文档/冒烟产品集/笔记/冒烟笔记.md'
  const abs = path.join(toLinux(WIN_WS), ...rel.split('/'))
  await call(page, async (r) => await window.qihebox.files.writeText(r, '# 冒烟\nwine 首次写入\n'), rel)
  assert(fs.existsSync(abs), `笔记未落到 Windows 路径：${abs}`)
  const r1 = await call(page, async (p) => await window.qihebox.files.readTextFile(p), winAbs(rel))
  assert(/wine 首次写入/.test(String(r1.data)), `读回不符：${String(r1.data).slice(0, 60)}`)
  // 二次写 = rename 覆盖已存在目标：Windows 与 POSIX 的 rename 语义分歧点，tmp 名唯一化在此才真被压到
  await call(page, async (r) => await window.qihebox.files.writeText(r, '# 冒烟\nwine 覆盖写\n'), rel)
  const r2 = await call(page, async (p) => await window.qihebox.files.readTextFile(p), winAbs(rel))
  assert(/wine 覆盖写/.test(String(r2.data)), '覆盖写未生效（Windows rename 不覆盖旧目标）')
  const leftovers = fs.readdirSync(path.dirname(abs)).filter((f) => f.endsWith('.tmp'))
  assert(leftovers.length === 0, `残留 .tmp 未清理：${leftovers.join(',')}`)
  return '含二次覆盖写 + 无 tmp 残留'
})

await step('同内容证书导入 + 硬链接去重巡检 dedupSweep', async () => {
  const r = await call(
    page,
    async (src) =>
      await window.qihebox.files.import({
        source_paths: [src + '\\质检报告.pdf', src + '\\质检报告-副本.pdf'],
        target_product_set: '冒烟产品集',
        target_type: 'cert',
        sub_folder: '质检',
      }),
    WIN_SRC,
  )
  void r
  const ev2 = await waitImportComplete(page, importEvents++)
  const d = ev2
  // 导入期去重（D3）与巡检期去重（D3.5）任一生效即可：都属「同内容只存一份」
  const swept = await call(page, async () => await window.qihebox.files.dedupSweep())
  const s = swept.data || {}
  const linkedAtImport = Number(d.linked && d.linked.length) || 0
  const dir = path.join(toLinux(WIN_WS), '产品集', '冒烟产品集', '证书', '质检')
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : []
  assert(names.length >= 2, `证书目录里只有 ${names.length} 个文件：${names.join(',')}`)
  const nlink2 = names.filter((n) => {
    try {
      return fs.statSync(path.join(dir, n)).nlink >= 2
    } catch {
      return false
    }
  })
  assert(
    nlink2.length >= 2 || linkedAtImport > 0 || Number(s.relinked) >= 1,
    `同内容证书既没链接也没巡检重建：import=${JSON.stringify(d)} sweep=${JSON.stringify(s)}`,
  )
  return `导入 linked=${linkedAtImport} · 巡检 groups=${s.groups ?? 0} relinked=${s.relinked ?? 0} saved=${s.bytesSaved ?? 0}B · nlink≥2 的 ${nlink2.length} 个（NTFS 限制见真机清单）`
})

await step('回收站：删除 → 列表 → 还原 → 回位', async () => {
  const victim = imgA
  await call(page, async (p) => await window.qihebox.files.delete(p), [victim])
  await until(async () => (fs.existsSync(toLinux(victim)) ? null : true), '文件已从 Windows 路径移走')
  const list = await call(page, async () => await window.qihebox.trash.list())
  const items = list.data || []
  const item = items.find((x) => String(x.originalPath || '').replace(/\\/g, '/') === victim.replace(/\\/g, '/'))
  assert(item, `回收站里找不到被删文件（${items.length} 条）：${JSON.stringify(items.map((i) => i.name)).slice(0, 160)}`)
  await call(page, async (id) => await window.qihebox.trash.restore(id), item.id)
  await until(() => (fs.existsSync(toLinux(victim)) ? true : null), '还原后文件回到原 Windows 路径')
  return `往返通过（回收站 ${items.length} 条时命中）`
})

await step('搜索命中（索引在 Windows 路径下重建）', async () => {
  const r = await call(page, async () => await window.qihebox.search('主图B'))
  const files = (r.data && r.data.files) || []
  assert(files.length >= 1, `搜不到改名后的文件：files=${files.length} sets=${((r.data || {}).product_sets || []).length}`)
  return `${files.length} 条命中`
})

await step('仪表盘计数自洽', async () => {
  const r = await call(page, async () => await window.qihebox.dashboard.stats())
  const s = r.data || {}
  assert(Number(s.total_product_sets) >= 1, `产品集计数异常：${JSON.stringify(s)}`)
  assert(Number(s.total_images) >= 2, `图片计数异常（导入 2 张）：${JSON.stringify(s)}`)
  return `产品集 ${s.total_product_sets} · 图 ${s.total_images} · 证书 ${s.total_certs}`
})

await step('剪贴板复制文件（PowerShell Set-Clipboard 通道）', async () => {
  const r = await call(page, async (p) => await window.qihebox.files.copyFilesToClipboard(p), [imgA])
  assert(r.success !== false, `copyFilesToClipboard 失败：${r.error}`)
  // 口径写死到 spawn 层：wine 10.14 的 powershell.exe 是**空转 stub**（2026-09-13 实测：
  // `-Command "Set-Content C:\x.txt"` 回 rc=0 但文件根本没写出来；同前缀下 cmd /c 能真写）
  // ⇒ 本断言只证「命令能被 spawn 且退出码 0」，剪贴板里到底有没有 CF_HDROP 不可证 → W2 真机清单
  return 'powershell.exe 可 spawn 且 rc=0（wine 无真 PowerShell，剪贴板内容本身不可证，见 W2 真机清单）'
})

// v2.5.8 D19 读侧（Ctrl+V 粘贴导入的前置通道）：powershell Get-Clipboard -Format FileDropList。
// 2026-09-13 首跑实测：**读回 0 条**，根因不是代码——wine 10.14 的 powershell.exe 是空转 stub
// （探针：`-Command "Set-Content C:\qhe-ps-probe.txt"` 回 rc=0 但文件没写出来；同前缀下 cmd /c 能真写）
// ⇒ 本步按 soft 登记，真机验到「粘贴导入收得到外部复制的文件」后再改 'hard' 并注明日期。
await step(
  '剪贴板读回文件列表（PowerShell Get-Clipboard -Format FileDropList 通道）',
  async () => {
    const r = await call(page, async () => await window.qihebox.files.readClipboardFiles())
    const got = r.data || []
    assert(got.length > 0, '读回 0 条——非代码缺陷：wine 的 powershell.exe 是空转 stub（cmdlet 根本不执行），本步在 wine 下必然不可证，归 W2 真机清单')
    assert(
      got.some((p) => String(p).toLowerCase() === imgA.toLowerCase()),
      `读回列表不含刚复制的那张：期望 ${imgA}，实际 ${JSON.stringify(got)}`,
    )
    return `读回 ${got.length} 条 · ${path.win32.basename(got[0])}`
  },
  'soft',
)

await step('资源管理器选中（弱断言：explorer.ts 超时也当成功）', async () => {
  const r = await call(page, async (p) => await window.qihebox.files.showFilesInExplorer(p), [imgA])
  assert(r.success !== false, `showFilesInExplorer 失败：${r.error}`)
  return '不抛错即过（选中效果需真机看，见 W2）'
})

// —— 诊断项（不判红）——
await step('图标字形宽度诊断（字体没装好会挤坏排版）', async () => {
  const w = await page.evaluate(() => {
    const el = [...document.querySelectorAll('aside span, nav span')].find((s) =>
      /\p{Extended_Pictographic}/u.test(s.textContent || ''),
    )
    return el ? Math.round(el.getBoundingClientRect().width) : -1
  })
  if (w < 0) throw new Error('页面上找不到含 emoji 的 span（改版了？该复查诊断有效性）')
  if (w > 64) throw new Error(`图标 span 宽 ${w}px，疑字体缺失（缺字体实测 32768px；正常约 16–32px）`)
  return `图标 span 宽 ${w}px`
}, 'soft')

await step('文件夹保留名探针（台账 W-01：CON 能否建成）', async () => {
  const r = await page.evaluate(async () => await window.qihebox.productSets.create({ name: 'CON' }))
  const created = !!(r && r.success)
  const onDisk = fs.existsSync(path.join(toLinux(WIN_WS), '产品集', 'CON'))
  if (created) throw new Error(`建出来了（磁盘${onDisk ? '有' : '无'} CON 目录）= W-01 在 Windows 环境同样成立`)
  return `已被拒：${String(r && r.error).slice(0, 60)}`
}, 'soft')

await step('截图取证（仅归档，不作判定）', async () => {
  const file = path.join(ARTIFACTS, 'win-smoke-window.png')
  await page.screenshot({ path: file })
  assert(fs.existsSync(file) && fs.statSync(file).size > 1000, '截图为空')
  return `${path.relative(ROOT, file)} ${Math.round(fs.statSync(file).size / 1024)}KB`
})

await browser.close().catch(() => {})

// 主日志体检（放最后，才能覆盖全流程产生的日志）
await step('主进程日志体检（零 FATAL / 零渲染进程异常退出 / 零资源加载失败）', async () => {
  const logDir = findUserData(USERDATA).logs
  assert(logDir, `找不到主进程日志目录（前缀内 */Temp/${USERDATA}/logs）`)
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log'))
  const all = files.map((f) => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n')
  fs.writeFileSync(path.join(ARTIFACTS, 'main-process.log'), all)
  const bad = []
  for (const [re, why] of [
    [/\[fatal\]/i, 'FATAL 级日志'],
    [/render-process-gone/i, '渲染进程异常退出'],
    [/unresponsive/i, '渲染进程无响应'],
    [/Failed to load URL|ERR_FILE_NOT_FOUND|ERR_UNKNOWN_URL_SCHEME/i, '资源加载失败'],
    [/UnhandledPromiseRejection|TypeError: .*is not a function/i, '未捕获异常'],
  ]) {
    const hit = all.split('\n').filter((l) => re.test(l))
    if (hit.length) bad.push(`${why}×${hit.length}：${hit[0].slice(0, 120)}`)
  }
  assert(bad.length === 0, bad.join(' / '))
  return `${files.length} 个日志共 ${all.split('\n').length} 行干净`
})

closeBrowser().then(killApp).then(finishAndExit)

/** 关掉 CDP 连接（若已建立） */
async function closeBrowser() {
  try {
    if (browser) await browser.close()
  } catch {
    /* 应用已被杀，忽略 */
  }
}

/** 关掉 wine 应用与本前缀的 wineserver（带 WINEPREFIX，否则会杀到宿主默认前缀） */
function killApp() {
  if (KEEP_APP || !child || !child.pid) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      process.kill(child.pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
  spawnSync('wineserver', ['-k'], { env: process.env, timeout: 30_000 })
}

/** 落报告 + 打印结论 + 按失败数定退出码（失败路径也要有报告，不然查不到红在哪） */
function finishAndExit() {
  const secs = Number(((Date.now() - t0) / 1000).toFixed(1))
  fs.writeFileSync(
    path.join(ARTIFACTS, 'win-smoke-report.json'),
    JSON.stringify({ at: new Date().toISOString(), secs, passed, failed, softened, exeOriginal, report }, null, 2),
  )
  console.log(
    `\n[win-smoke] 结论：${failed === 0 ? '绿' : '红'} — 断言 ${passed}（含诊断 ${softened}）· 失败 ${failed} · 耗时 ${secs}s`,
  )
  if (failed) {
    console.error(
      '[win-smoke] 失败项：\n' + report.filter((r) => !r.ok).map((r) => `  - ${r.name}：${r.note}`).join('\n'),
    )
    process.exit(1)
  }
  process.exit(0)
}
