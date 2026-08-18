/**
 * v2.5.3 内存实测脚本：醒着 / 关窗隐藏 / 托盘常驻（或自启态）三态采样。
 * （v2.5.3 起移除分层休眠：托盘常驻 = 窗口隐藏但渲染进程常驻，不再有 30s 销毁倒计时）
 *
 * 用法：
 *   node scripts/measure-memory.mjs [--repeat N] [--autostart] [--seed-plugins path[,path...]]
 *
 * - 以 electron-builder 同款参数启动 `out/` 产物，XDG_CONFIG_HOME 指向每轮独立临时目录；
 * - 每个场景输出逐进程 role/pid/RSS/PSS/private/swap，最后一行输出完整 JSON；
 * - 启动、自动化、采样、进程角色检查任一失败即以非零状态退出，禁止把无效数据当基线；
 * - `--repeat >= 3` 时验证每个场景总 RSS 的变异系数不超过 5%。
 */
import { _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertAutostartReady,
  assertMemorySnapshot,
  assertStableMemorySummary,
  parseMemoryMeasurementArgs,
  parseMemorySamplerOutput,
  sumMemorySnapshot,
  summarizeMemoryRuns,
} from './memory-measurement.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 与 electron-builder.yml linux.executableArgs 保持一致的启动参数（v2.4.6 已同步） */
const PROD_ARGS = [
  '--no-zygote',
  '--no-sandbox',
  '--disable-gpu',
  '--in-process-gpu', // 实测必需：--disable-gpu 下 gpu 进程仍创建，此参数将其并回主进程
  '--js-flags=--max-old-space-size=768',
]

const SAMPLER = `#!/usr/bin/env bash
set -uo pipefail

tree_pids() {
  ps -eo pid=,ppid= | awk -v root="$1" '{children[$2] = children[$2] " " $1} END {queue[0] = root; head = 0; tail = 1; while (head < tail) {pid = queue[head++]; print pid; count = split(children[pid], childPids, " "); for (i = 1; i <= count; i++) if (childPids[i] != "") queue[tail++] = childPids[i]}}'
}

# fail-closed：任何 /proc 读取失败或字段缺失都标记不稳定，整张快照判为不可用；
# 进程已退出的竞态由调用方重试整张快照一次，重试仍不稳定则整体失败。
unstable=0

for pid in $(tree_pids "$1"); do
  comm=$(cat "/proc/$pid/comm" 2>/dev/null) || { unstable=1; continue; }
  [ "$comm" = "electron" ] || continue
  [ -r "/proc/$pid/status" ] || { unstable=1; continue; }

  rss=$(awk '/^Rss:/{print $2; found = 1} END {if (!found) {print -1; exit 1}}' "/proc/$pid/smaps_rollup") || { unstable=1; continue; }
  pss=$(awk '/^Pss:/{print $2; found = 1} END {if (!found) {print -1; exit 1}}' "/proc/$pid/smaps_rollup") || { unstable=1; continue; }
  private=$(awk '/^Private_Clean:|^Private_Dirty:/{total += $2; found = 1} END {if (!found) {print -1; exit 1} print total}' "/proc/$pid/smaps_rollup") || { unstable=1; continue; }
  swap=$(awk '/^VmSwap:/{print $2; found = 1} END {if (!found) {print -1; exit 1} print $2}' "/proc/$pid/status") || { unstable=1; continue; }
  cmdline=$(tr '\\0' ' ' < "/proc/$pid/cmdline") || { unstable=1; continue; }
  subtype=$(printf '%s' "$cmdline" | sed -n 's/.*--utility-sub-type=\\([^ ]*\\).*/\\1/p')

  role=main
  case "$cmdline" in
    *--type=renderer*) role=renderer ;;
    *--type=utility*) role=utility ;;
    *--type=*) role=other ;;
  esac
  [ -n "$subtype" ] || subtype=-
  printf 'role=%s subtype=%s pid=%s rss_kb=%s pss_kb=%s private_kb=%s swap_kb=%s\\n' "$role" "$subtype" "$pid" "$rss" "$pss" "$private" "$swap"
done

if [ "$unstable" = "1" ]; then
  echo "采样不稳定：存在进程竞态或 /proc 读取失败" >&2
  exit 3
fi
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runSampler(samplerPath, rootPid) {
  try {
    return execFileSync('bash', [samplerPath, String(rootPid)], { encoding: 'utf8' })
  } catch (error) {
    const details = error.stderr?.toString().trim() || error.message
    throw new Error(`内存采样失败：${details}`, { cause: error })
  }
}

export async function snapshot(label, samplerPath, rootPid, expectations, runSamplerImpl = runSampler) {
  console.log(`\n=== ${label} ===`)
  let output
  try {
    output = await runSamplerImpl(samplerPath, rootPid)
  } catch (error) {
    // 进程竞态（枚举后子进程退出）或 /proc 读取失败：整张快照重试一次，仍失败则整体失败
    console.warn(`[measure-memory] ${label} 采样不稳定，300ms 后重试一次：${error.message}`)
    await sleep(300)
    output = await runSamplerImpl(samplerPath, rootPid)
  }

  process.stdout.write(output)
  const processes = parseMemorySamplerOutput(output)
  assertMemorySnapshot(processes, expectations)
  return { label, processes, total: sumMemorySnapshot(processes) }
}

async function seedPlugins(page, pluginPaths) {
  if (pluginPaths.length === 0) return

  await page.evaluate(() => window.qihebox.settings.setDevMode(true))
  try {
    for (const filePath of pluginPaths) {
      const result = await page.evaluate((value) => window.qihebox.plugins.install({ filePath: value }), filePath)
      if (!result.success) throw new Error(`插件安装失败：${filePath}：${result.error ?? '未知错误'}`)
      console.log(`[seed] ${filePath} → 安装成功（${result.data?.id}）`)
    }
  } finally {
    await page.evaluate(() => window.qihebox.settings.setDevMode(false))
  }
}

async function closeApp(app) {
  if (!app) return
  const pid = app.process().pid
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 进程已自行退出。
    }
  }
  await Promise.race([app.close(), sleep(5000)]).catch(() => {})
}

async function measureOnce(options, run) {
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'qihebox-mem-'))
  const samplerPath = path.join(xdg, 'sampler.sh')
  fs.writeFileSync(samplerPath, SAMPLER, { mode: 0o755 })
  let app

  try {
    console.log(`\n######## 第 ${run}/${options.repeat} 次测量 ########`)
    app = await electron.launch({
      args: ['.', ...PROD_ARGS, ...(options.autostart ? ['--autostart'] : [])],
      cwd: ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: xdg },
    })

    const mainPid = app.process().pid
    if (options.autostart) {
      await sleep(8000)
      await assertAutostartReady(app, 10000)
      return {
        autostart: await snapshot('自启态（--autostart 延迟建窗、托盘常驻，空闲 8s）', samplerPath, mainPid, {
          requiresNetworkUtility: true,
          rendererMustBeAbsent: true,
        }),
      }
    }

    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!window.qihebox, null, { timeout: 10000 })
    await seedPlugins(page, options.seedPlugins)

    await sleep(8000)
    const awake = await snapshot('醒着（窗口打开，空闲 8s）', samplerPath, mainPid, { requiresRenderer: true })

    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close()
    })
    await sleep(4000)
    const closing = await snapshot('关窗后（隐藏到托盘，渲染进程常驻）', samplerPath, mainPid, { requiresRenderer: true })

    await sleep(8000) // 隐藏后空闲沉降（v2.5.3 起无销毁倒计时，不再等 34s）
    const tray = await snapshot('托盘常驻（窗口隐藏、渲染进程常驻，空闲 8s）', samplerPath, mainPid, {
      requiresRenderer: true,
      requiresNetworkUtility: true,
    })
    return { awake, closing, tray }
  } finally {
    await closeApp(app)
    fs.rmSync(xdg, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseMemoryMeasurementArgs(process.argv.slice(2))
  if (options.autostart && options.seedPlugins.length > 0) {
    throw new Error('--autostart 不支持 --seed-plugins：自启态不会创建渲染窗口')
  }

  const runs = []
  for (let run = 1; run <= options.repeat; run += 1) {
    const scenarios = await measureOnce(options, run)
    runs.push({ run, scenarios })
  }

  const summary = summarizeMemoryRuns(
    runs.map(({ scenarios }) =>
      Object.fromEntries(Object.entries(scenarios).map(([name, result]) => [name, result.total])),
    ),
  )
  if (options.repeat >= 3) {
    assertStableMemorySummary(summary, { maxCv: 5, expectedSamples: options.repeat })
  }
  // baselineEligible 仅在请求次数 >= 3 且各场景样本数齐全、稳定性断言通过后为 true
  const baselineEligible =
    options.repeat >= 3 && Object.values(summary).every((scenario) => scenario.samples === options.repeat)

  console.log(JSON.stringify({ schemaVersion: 1, options, baselineEligible, runs, summary }))
}

// 主入口守卫：模块可被单测动态 import（vitest 下 process.argv[1] 为 vitest 入口，不匹配则跳过 CLI 执行）
const isMainScript = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainScript) {
  await main().catch((error) => {
    console.error(`[measure-memory] ${error.stack ?? error.message}`)
    process.exitCode = 1
  })
}
