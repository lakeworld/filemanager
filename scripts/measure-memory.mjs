/**
 * v2.4.5 内存实测脚本（Deepin 本机）：醒着 / 关窗倒计时 / 托盘常驻 三场景 RSS·PSS·独占·swap 出数。
 *
 * 用法：node scripts/measure-memory.mjs（前提：`npx electron-vite build` 已产出 out/；本机有显示）
 *
 * 方法（对照 PLAN-v2.4.5 §四）：
 * - Playwright _electron 以【生产同款启动参数】启动 dev 产物；XDG_CONFIG_HOME 指向独立临时目录
 *   （与生产应用 userData 隔离：单实例锁不冲突、不碰真实数据）；
 * - 不设 QIHEBOX_E2E：保留「关窗→托盘→30s 销毁」完整休眠链路；
 * - 关窗经 app.evaluate 直接调主进程 BrowserWindow.close()（xdotool 按 pid 找窗口不可靠，勿用）；
 * - 采样：Playwright 直起 electron（无 npx 包装层），app.process().pid 即主进程，
 *   进程树 awk BFS 遍历 + /proc/<pid>/smaps_rollup（经 bash 子进程执行，node 直调 pgrep 在本机有兼容问题）。
 */
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MARK = `qihebox-mem-${Date.now()}`
const xdg = path.join(os.tmpdir(), MARK)
fs.mkdirSync(xdg, { recursive: true })

/** 与 electron-builder.yml linux.executableArgs 保持一致的启动参数（v2.4.6 已同步） */
const PROD_ARGS = [
  '--no-zygote',
  '--no-sandbox',
  '--disable-gpu',
  '--in-process-gpu', // 实测必需：--disable-gpu 下 gpu 进程仍创建，此参数将其并回主进程
  '--js-flags=--max-old-space-size=768',
]

const SAMPLER = `#!/bin/bash
tree_pids() {
  ps -eo pid=,ppid= | awk -v root="$1" '{c[$2]=c[$2]" "$1} END{q[0]=root;h=0;t=1;while(h<t){p=q[h++];print p;n=split(c[p],a," ");for(i=1;i<=n;i++)q[t++]=a[i]}}'
}
trss=0; tpss=0; tpriv=0; tswap=0; n=0
for pid in $(tree_pids "$2"); do
  [ -r "/proc/$pid/smaps_rollup" ] || continue
  [ "$(cat /proc/$pid/comm 2>/dev/null)" = "electron" ] || continue
  rss=$(awk '/^Rss:/{print $2}' /proc/$pid/smaps_rollup)
  pss=$(awk '/^Pss:/{print $2}' /proc/$pid/smaps_rollup)
  priv=$(awk '/^Private_Clean:|^Private_Dirty:/{s+=$2} END{print s+0}' /proc/$pid/smaps_rollup)
  swap=$(awk '/^VmSwap:/{print $2}' /proc/$pid/status)
  type=$(tr '\\0' ' ' < /proc/$pid/cmdline | grep -oE -- "--type=[a-z]+" | head -1)
  sub=$(tr '\\0' ' ' < /proc/$pid/cmdline | grep -oE -- "utility-sub-type=[a-z.]+" | head -1 | cut -c18-40)
  printf "  pid=%s %-22s RSS=%dMB PSS=%dMB 独占=%dMB swap=%dMB\\n" "$pid" "\${type:-main}\${sub:+/$sub}" "$((rss/1024))" "$((pss/1024))" "$((priv/1024))" "$((\${swap:-0}/1024))"
  trss=$((trss+rss)); tpss=$((tpss+pss)); tpriv=$((tpriv+priv)); tswap=$((tswap+\${swap:-0})); n=$((n+1))
done
printf "  合计 %d 进程：RSS=%dMB PSS=%dMB 独占=%dMB swap=%dMB\\n" "$n" "$((trss/1024))" "$((tpss/1024))" "$((tpriv/1024))" "$((tswap/1024))"
`
const samplerPath = path.join(os.tmpdir(), `qihebox-sampler-${Date.now()}.sh`)
fs.writeFileSync(samplerPath, SAMPLER, { mode: 0o755 })

function snapshot(label, rootPid) {
  console.log(`\n=== ${label} ===`)
  try {
    process.stdout.write(execFileSync('bash', [samplerPath, label, String(rootPid)], { encoding: 'utf8' }))
  } catch (e) {
    console.log('  [采样失败]', e.message)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// v2.4.9（S4）：自启态专项变体——`node scripts/measure-memory.mjs --autostart`
// 以 `--autostart` 启动（延迟建窗、无渲染进程、托盘常驻），仅测单一稳态，实测 3 次取稳定值。
const AUTOSTART = process.argv.includes('--autostart')

// v2.5.1（D12）：插件内存测量——`node scripts/measure-memory.mjs --seed-plugins <qbox>[,<qbox>...]`
// 醒着档启动后经渲染层侧载安装指定 .qbox（开发者模式自动开），空闲 8s 采样；
// 用于「插件未启用零内存 / 启用后按需加载」档位实测（PLAN-v2.6-v2.7 §4.5 D12）。
const seedIdx = process.argv.indexOf('--seed-plugins')
const SEED_PLUGINS =
  seedIdx >= 0 && process.argv[seedIdx + 1] ? process.argv[seedIdx + 1].split(',').map((s) => s.trim()).filter(Boolean) : []

const app = await electron.launch({
  args: ['.', ...PROD_ARGS, ...(AUTOSTART ? ['--autostart'] : [])],
  cwd: ROOT,
  env: { ...process.env, XDG_CONFIG_HOME: xdg },
})

try {
  const mainPid = app.process().pid
  if (AUTOSTART) {
    // 自启态无窗口：不调 firstWindow（会挂起等待），直接空闲 8s 后采样托盘常驻档
    await sleep(8000)
    snapshot('自启态（--autostart 延迟建窗、托盘常驻，空闲 8s）', mainPid)
  } else {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window).qihebox, null, { timeout: 10000 })
    // D12：seed 插件（侧载安装，与 conformance 同链路；安装后插件自动激活）
    if (SEED_PLUGINS.length > 0) {
      await page.evaluate(() => (window).qihebox.settings.setDevMode(true))
      for (const fp of SEED_PLUGINS) {
        const r = await page.evaluate(async (p) => (window).qihebox.plugins.install({ filePath: p }), fp)
        console.log(`[seed] ${fp} → ${r.success ? `安装成功（${r.data?.id}）` : `失败：${r.error}`}`)
      }
      await page.evaluate(() => (window).qihebox.settings.setDevMode(false))
    }
    await sleep(8000)
    snapshot('醒着（窗口打开，空闲 8s）', mainPid)

    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.close()
    })
    await sleep(4000)
    snapshot('关窗后（隐藏到托盘，销毁倒计时中）', mainPid)
    await sleep(34000)
    snapshot('托盘常驻（30s 休眠销毁后）', mainPid)
  }
} finally {
  try {
    process.kill(-app.process().pid, 'SIGKILL')
  } catch {
    try { process.kill(app.process().pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  await Promise.race([app.close(), sleep(5000)]).catch(() => {})
  fs.rmSync(xdg, { recursive: true, force: true })
  fs.rmSync(samplerPath, { force: true })
}
