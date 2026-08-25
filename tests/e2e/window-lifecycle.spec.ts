/**
 * 窗口生命周期 e2e（v2.5.3 常驻轻壳 + 2026-08-19 托盘冻结热修）——设计依据
 * `docs/INTERNAL/PLAN-v2.5.3-托盘冻结根治.md`（热修定案：删 FrameWitness 隐藏预检，
 * 改「先显示、后验证」——长时隐藏后合成器休眠抓不到帧，预检 unknown 会堵死唤醒）：
 * 1. 健康托盘恢复 100 轮：直接 show（无预检），断言零 reload/零销毁/零白屏升级，输出 p50/p95
 * 2. 单轮恢复：显示后白屏自检必跑（show 后 300ms 可见态抓帧）且通过，零升级
 * 3. 最小化到托盘 20 轮：windowMinimize 统一入口；恢复 = 直接 show + 显示后自检兜底
 * 4. 快速竞态：hide 后立即 show、连续双击托盘、托盘与 wake 并发——只有最新 generation 生效
 * 5. 故障注入（走真实显示后自检链）：capturePage 单次空白（疑似 → invalidate 复检恢复）、
 *    连续空白（白屏确认 → 可见态 L2 reload 单发收口）、capturePage 抛错（unknown 不升级
 *    不阻塞唤醒——本次托盘冻结事故回归守卫）、blank-confirmed 注入（visible → L2；parked →
 *    忽略）、unresponsive（hide + L2）、renderer crash（L4 销毁重建 → ready-to-show 收口）
 *
 * 执行环境：本机（xvfb 亦可——显示后自检走真实可见态 capturePage，无隐藏态抓帧依赖）。
 *
 * 2026-08-18 恢复链定案沿用：健康路径与故障注入拆分两个 describe（独立 app）——故障注入
 * 用例会 L2/L4 重建，共享 app 会污染后续用例时序。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 读主进程当日日志全文（e2e 隔离 logs 目录：app.getPath('logs')，文件名 main-<本地日期>.log） */
async function readMainLog(app: ElectronApplication): Promise<string> {
  const logsDir = await app.evaluate(({ app: a }) => a.getPath('logs'))
  let text = ''
  try {
    const files = (await fsp.readdir(logsDir)).filter((f) => f.startsWith('main-') && f.endsWith('.log'))
    for (const f of files) text += await fsp.readFile(path.join(logsDir, f), 'utf8')
  } catch {
    /* 日志目录不存在/空 → '' */
  }
  return text
}

/** 日志中匹配正则的行数（全局匹配计数） */
function countLogLines(text: string, re: RegExp): number {
  const g = re.global ? re : new RegExp(re.source, re.flags + 'g')
  return (text.match(g) ?? []).length
}

/** 崩溃/故障恢复链：L2 reload 后 Electron 重建渲染层文档、L4 销毁重建新窗口——
 *  L4 会使原 page 句柄失效。此 helper 重取窗口并等待业务层挂载（最终恢复可见），
 *  **返回实际可用的 page 句柄**——调用方必须用返回值覆盖旧 page（L4 后旧句柄已销毁，
 *  继续用会 Target closed，2026-08-18 晚批量实证 3 例 waitForTimeout 红即此根因）。 */
async function waitBizMountedResilient(app: ElectronApplication, page: Page, timeoutMs = 30000): Promise<Page> {
  const sel = 'main[class*="overflow-y-auto"]'
  try {
    await page.waitForFunction((s) => !!document.querySelector(s), sel, { timeout: timeoutMs })
    return page
  } catch {
    // L4 销毁重建：win.destroy() 到 ensureMainWindow 新窗口 ready 之间有 target 真空期，
    // Playwright evaluate/firstWindow 在此窗口会报 Target closed——轮询等新窗口 target 建立
    const deadline = Date.now() + timeoutMs
    let lastErr: unknown = new Error('waitBizMountedResilient: 未等到业务层挂载')
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800))
      try {
        const p2 = await app.firstWindow()
        await p2.waitForFunction((s) => !!document.querySelector(s), sel, { timeout: 5000 })
        return p2
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  }
}

test.describe('冷启动分段计时（T5 步骤 5：壳层首帧 vs Dashboard settled）', () => {
  test('壳层可交互不等待业务数据；记录 launch→壳层→stats 三段耗时', async () => {
    const tLaunch = Date.now()
    const cold = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    try {
      const coldPage = await cold.firstWindow()
      await coldPage.waitForLoadState('domcontentloaded')
      await coldPage.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
      const tShell = Date.now()
      // 冷启动双闸门：等待窗口实际可见（ready-to-show + first-frame-ack 齐备后状态机 show）
      await coldPage.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 15000 })
      // 壳层可交互不等待业务数据：stats 计时为窗口可见后的轻量 IPC（Dashboard settled 由业务层负责）
      const statsOk = await coldPage.evaluate(async () => {
        try {
          const r = await (window as any).qihebox.dashboard.stats()
          return !!r && r.success !== false
        } catch {
          return false
        }
      })
      const tSettled = Date.now()
      const shellMs = tShell - tLaunch
      const settledMs = tSettled - tLaunch
      console.log(`[lifecycle] 冷启动分段：launch→壳层可交互 ${shellMs}ms；launch→stats 返回 ${settledMs}ms（差值 ${settledMs - shellMs}ms）`)
      // 壳层快速（本地单轮宽松线 3s；p95 ≤1.5s 门禁在 T6 真机多轮验收）
      expect(shellMs, `壳层可交互耗时 ${shellMs}ms 超本地宽松线 3000ms`).toBeLessThanOrEqual(3000)
      // 冷启动双闸门：窗口最终可见（ready-to-show + first-frame-ack 齐备后状态机 show）
      const visible = await cold.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
      expect(visible, '冷启动双闸门后窗口应可见').toBe(true)
      expect(statsOk, '壳层可交互后 stats 应可用').toBe(true)
    } finally {
      try {
        process.kill(cold.process().pid!, 'SIGKILL')
      } catch { /* 已退出 */ }
      await Promise.race([cold.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
  })
})

test.describe('窗口生命周期（v2.5.3 常驻轻壳 T5 + 托盘冻结热修）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
    // 冷启动双闸门：等待窗口实际可见（ready-to-show + first-frame-ack 齐备后状态机 show）
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 15000 })
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, '冷启动双闸门后窗口应可见').toBe(true)
  })

  test.afterAll(async () => {
    if (app) {
      try {
        process.kill(app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
  })

  /** 单轮托盘隐藏→恢复：hide → parked（业务层卸载）→ 直接 show → 可见 + 业务层挂载；返回耗时 ms */
  async function hideShowRound(): Promise<number> {
    await page.evaluate(() => (window as any).qihebox.window.hideToTray())
    await page.waitForFunction(() => !document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 10000 })
    const t0 = Date.now()
    await page.evaluate(() => (window as any).qihebox.window.show())
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
    return Date.now() - t0
  }

  /** 当前日志快照里升级/白屏确认/自检通过计数（健康轮必须零增长升级） */
  async function escalationCounts(): Promise<{ l2: number; l4: number; blankConfirmed: number; checkPassed: number }> {
    const log = await readMainLog(app)
    return {
      l2: countLogLines(log, /L2 reload 渲染进程/),
      l4: countLogLines(log, /L4 销毁重建/),
      blankConfirmed: countLogLines(log, /显示后白屏确认/),
      checkPassed: countLogLines(log, /显示后自检通过/),
    }
  }

  test('健康托盘恢复 100 轮：直接 show 零升级零白屏，输出 p50/p95', async () => {
    // 每轮 = hide（卸载）+ 直接 show（重挂），无预检抓帧——正常每轮 <500ms，100 轮宽松上限 10min
    test.setTimeout(600000)
    const ROUNDS = 100
    const samples: number[] = []
    const before = await escalationCounts()
    for (let i = 0; i < ROUNDS; i += 1) {
      samples.push(await hideShowRound())
      // 每轮健康：窗口可见 + 业务层在
      const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
      expect(visible, `第 ${i + 1} 轮恢复后窗口应可见`).toBe(true)
    }
    const after = await escalationCounts()
    const sorted = [...samples].sort((a, b) => a - b)
    const p50 = sorted[Math.floor(sorted.length * 0.5)]
    const p95 = sorted[Math.floor(sorted.length * 0.95)]
    console.log(`[lifecycle] 健康恢复 100 轮 hide→biz 耗时 p50=${p50}ms p95=${p95}ms 分布=${samples.slice(0, 20).join(',')}...`)
    expect(after.l2, '健康恢复不得触发 L2 reload（零升级）').toBe(before.l2)
    expect(after.l4, '健康恢复不得触发 L4 销毁重建').toBe(before.l4)
    expect(after.blankConfirmed, '健康恢复不得确认白屏（显示后自检不得误判）').toBe(before.blankConfirmed)
    // 窗口实例未被销毁重建（仍只有一个主窗口）
    const winCount = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
    expect(winCount, '健康轮不得产生新窗口实例').toBe(1)
    // 恢复耗时门禁（直接 show 无预检，p95 应远低于此；宽松线防机器负载噪声）
    expect(p95, `健康恢复 p95=${p95}ms 超 1500ms 门禁`).toBeLessThanOrEqual(1500)
  })

  test('单轮恢复：显示后白屏自检必跑且通过，零升级', async () => {
    const before = await escalationCounts()
    await hideShowRound()
    // 自检在 show 后 300ms 抓帧；高负载下自检点可能命中加载中——main 等加载 settle 后才
    // 真正跑自检（上限 5s，2026-08-25 flake 修复），故不用固定 600ms，改有界轮询「自检通过」日志（10s 截止）
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const log = await readMainLog(app)
      if (countLogLines(log, /显示后自检通过/) > before.checkPassed) break
      await new Promise((r) => setTimeout(r, 200))
    }
    const after = await escalationCounts()
    expect(after.checkPassed - before.checkPassed, 'parked 恢复 show 必须武装并跑完显示后白屏自检').toBeGreaterThanOrEqual(1)
    expect(after.blankConfirmed - before.blankConfirmed, '健康自检不得确认白屏').toBe(0)
    expect(after.l2 - before.l2, '健康自检不得触发 L2').toBe(0)
    expect(after.l4 - before.l4, '健康自检不得触发 L4').toBe(0)
  })

  test('最小化到托盘 20 轮：统一入口直接恢复，零升级', async () => {
    test.setTimeout(300000)
    const ROUNDS = 20
    const before = await escalationCounts()
    for (let i = 0; i < ROUNDS; i += 1) {
      // TitleBar 最小化按钮同款 IPC（windowMinimize 统一入口，不再走系统 minimize）
      await page.evaluate(() => (window as any).qihebox.window.minimize())
      await page.waitForFunction(() => !document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 10000 })
      await page.evaluate(() => (window as any).qihebox.window.show())
      await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
    }
    const after = await escalationCounts()
    expect(after.l2 - before.l2, '最小化恢复 20 轮不得触发 L2').toBe(0)
    expect(after.l4 - before.l4, '最小化恢复 20 轮不得触发 L4').toBe(0)
    expect(after.blankConfirmed - before.blankConfirmed, '最小化恢复不得确认白屏').toBe(0)
  })

  test('竞态：hide 后立即 show（快速连续切换 10 次）→ 最终可见且无升级', async () => {
    const before = await escalationCounts()
    for (let i = 0; i < 10; i += 1) {
      await page.evaluate(() => (window as any).qihebox.window.hideToTray())
      await page.evaluate(() => (window as any).qihebox.window.show())
      await page.waitForTimeout(80)
    }
    // 最终稳定：业务层挂载 + 窗口可见（最后一次 show 生效）
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible).toBe(true)
    const after = await escalationCounts()
    expect(after.l2 - before.l2, '快速切换不得触发 L2').toBe(0)
    expect(after.l4 - before.l4, '快速切换不得触发 L4').toBe(0)
  })

  test('竞态：连续两次托盘恢复（双击）→ 只有最新 generation 生效，无升级', async () => {
    const before = await escalationCounts()
    // 双击：两次 show 几乎同时（第二次在 visible 态被状态机忽略）
    await page.evaluate(() => {
      ;(window as any).qihebox.window.show()
      ;(window as any).qihebox.window.show()
    })
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible).toBe(true)
    const after = await escalationCounts()
    expect(after.l2 - before.l2, '双击托盘不得触发 L2').toBe(0)
    expect(after.l4 - before.l4, '双击托盘不得触发 L4').toBe(0)
  })

  test('竞态：托盘恢复与 wake resume 并发 → 无升级，最终可见', async () => {
    const before = await escalationCounts()
    await page.evaluate(() => (window as any).qihebox.window.hideToTray())
    await page.waitForFunction(() => !document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 10000 })
    // 并发：show 与 powerMonitor resume（未记录暂停前可见 → 不自行显示；show 路径正常恢复）
    await page.evaluate(() => {
      ;(window as any).qihebox.window.show()
    })
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('resume')
      return true
    })
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible).toBe(true)
    const after = await escalationCounts()
    expect(after.l2 - before.l2, '托盘与 wake 并发不得触发 L2').toBe(0)
    expect(after.l4 - before.l4, '托盘与 wake 并发不得触发 L4').toBe(0)
  })

  test('竞态：系统暂停（可见窗口）→ 隐藏；唤醒 → 直接恢复显示', async () => {
    const before = await escalationCounts()
    // suspend：可见窗口 → 立即隐藏 + parking
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('suspend')
      return true
    })
    await page.waitForFunction(() => !document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 10000 })
    // resume：暂停前可见 → 直接 show 恢复（显示后自检兜底）
    await app.evaluate(({ powerMonitor }) => {
      powerMonitor.emit('resume')
      return true
    })
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, '暂停前可见的窗口唤醒后应自动恢复').toBe(true)
    const after = await escalationCounts()
    expect(after.l2 - before.l2, '系统暂停/唤醒健康路径不得触发 L2').toBe(0)
    expect(after.l4 - before.l4, '系统暂停/唤醒健康路径不得触发 L4').toBe(0)
  })
})

test.describe('窗口生命周期故障注入（v2.5.3 热修语义，独立 app 隔离，避免共享 app 污染后续用例时序）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
    // 冷启动双闸门：等待窗口实际可见（ready-to-show + first-frame-ack 齐备后状态机 show）
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 15000 })
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, '冷启动双闸门后窗口应可见').toBe(true)
  })

  test.afterAll(async () => {
    if (app) {
      try {
        process.kill(app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
  })

  /** 当前日志快照里升级/白屏确认计数 */
  async function escalationCounts(): Promise<{ l2: number; l4: number; blankConfirmed: number }> {
    const log = await readMainLog(app)
    return {
      l2: countLogLines(log, /L2 reload 渲染进程/),
      l4: countLogLines(log, /L4 销毁重建/),
      blankConfirmed: countLogLines(log, /显示后白屏确认/),
    }
  }

  /** 单轮托盘隐藏→恢复（故障注入组同款流程） */
  async function hideShowRound(): Promise<void> {
    await page.evaluate(() => (window as any).qihebox.window.hideToTray())
    await page.waitForFunction(() => !document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 10000 })
    await page.evaluate(() => (window as any).qihebox.window.show())
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
  }

  test('故障注入：capturePage 单次空白帧 → 疑似白屏 → invalidate 复检恢复，零升级', async () => {
    const before = await escalationCounts()
    // 覆写 capturePage：首次调用返回全白帧，之后放行真实实现
    await patchCapturePage(app, { blankN: 1 })
    try {
      await hideShowRound()
      const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
      expect(visible, '单次空白复检恢复后窗口应可见').toBe(true)
      // 自检链：show+300ms 首抓（注入空白）→ invalidate 重绘 → +200ms 复检（真实帧）→ 复检恢复
      await page.waitForTimeout(1200)
      const log = await readMainLog(app)
      expect(log, '首抓空白应记录疑似白屏').toMatch(/显示后自检疑似白屏/)
      expect(log, 'invalidate 后真实帧应复检恢复').toMatch(/显示后自检复检恢复/)
      const after = await escalationCounts()
      expect(after.blankConfirmed - before.blankConfirmed, '单次空白复检恢复不得确认白屏').toBe(0)
      expect(after.l2 - before.l2, '单次空白复检恢复不得触发 L2').toBe(0)
      expect(after.l4 - before.l4, '单次空白不得触发 L4').toBe(0)
    } finally {
      await restoreCapturePage(app)
    }
  })

  test('故障注入：capturePage 连续空白（首抓+复检全白）→ 白屏确认 → 可见态 L2 reload 收口', async () => {
    const before = await escalationCounts()
    // 首抓与复检都返回全白 → blank-confirmed → 可见态 L2（不 hide）→ did-finish-load 收口 show
    await patchCapturePage(app, { blankN: 2 })
    try {
      await hideShowRound()
      // 自检链耗时（300+200ms+抓帧）后开始升级：轮询等白屏确认 + L2 日志出现
      const deadline = Date.now() + 15000
      let log = ''
      while (Date.now() < deadline) {
        log = await readMainLog(app)
        if (/显示后白屏确认/.test(log) && countLogLines(log, /L2 reload 渲染进程/) > before.l2) break
        await new Promise((r) => setTimeout(r, 200))
      }
      expect(log, '连续空白应记录疑似白屏（首抓）').toMatch(/显示后自检疑似白屏/)
      expect(log, '复检仍空白应确认白屏并升级').toMatch(/显示后白屏确认/)
      // L2 reload 后业务层重挂（页面重载，helper 等待新文档挂载）
      page = await waitBizMountedResilient(app, page)
      // L2 收口异步收敛：等待 1.5s 稳定，避免用例结束时状态未稳定污染后续用例
      await page.waitForTimeout(1500)
      const after = await escalationCounts()
      expect(after.l2 - before.l2, '连续空白应触发一次可见态 L2 reload').toBe(1)
      expect(after.l4 - before.l4, '单发白屏确认不得触发 L4').toBe(0)
      const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
      expect(visible, 'L2 收口后窗口应可见').toBe(true)
    } finally {
      await restoreCapturePage(app)
    }
  })

  test('故障注入：capturePage 抛错（unknown）→ 不升级不阻塞，窗口保持可见（托盘冻结事故回归守卫）', async () => {
    // 事故根因（动作-2026-08-19-托盘长时隐藏冻结定位.md）：旧隐藏预检在 capturePage 永远
    // unknown 时无限弹「重试/退出」模态框吞掉托盘点击 → 唤不醒。新语义：截图故障 ≠ 画面故障，
    // unknown 仅告警不升级，更不得阻塞唤醒——本用例钉死这条红线。
    const before = await escalationCounts()
    await patchCapturePage(app, { throwAlways: true })
    try {
      await hideShowRound() // 若退回旧语义，此处 waitForFunction 会超时（唤不醒）
      const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
      expect(visible, '截图故障不得阻塞唤醒（唤不醒比白屏更糟）').toBe(true)
      // 自检在 show+300ms 抓帧抛错 → 仅告警
      await page.waitForTimeout(600)
      const log = await readMainLog(app)
      expect(log, '截图故障应留告警日志').toMatch(/显示后自检截屏失败|显示后自检抓帧失败\/超时/)
      const after = await escalationCounts()
      expect(after.blankConfirmed - before.blankConfirmed, 'unknown 不得确认白屏').toBe(0)
      expect(after.l2 - before.l2, 'unknown 不升级原则：截图故障 ≠ 画面故障').toBe(0)
      expect(after.l4 - before.l4, 'unknown 不得触发 L4').toBe(0)
    } finally {
      await restoreCapturePage(app)
    }
  })

  test('故障注入：visible 态 blank-confirmed 注入 → 可见态 L2 reload → did-finish-load 收口', async () => {
    const before = await escalationCounts()
    // 直接喂状态机 blank-confirmed（显示后自检确认语义的主进程后门，QIHEBOX_E2E 门控）
    await app.evaluate(() => {
      ;(globalThis as any).__injectBlankConfirmed?.()
      return true
    })
    // L2 reload 同步发起：轮询等日志，再等业务层在新文档重挂
    const deadline = Date.now() + 15000
    let log = ''
    while (Date.now() < deadline) {
      log = await readMainLog(app)
      if (countLogLines(log, /L2 reload 渲染进程/) > before.l2) break
      await new Promise((r) => setTimeout(r, 200))
    }
    page = await waitBizMountedResilient(app, page)
    await page.waitForTimeout(1000) // 收口稳定
    const after = await escalationCounts()
    expect(after.l2 - before.l2, 'blank-confirmed 应触发一次可见态 L2 reload').toBe(1)
    expect(after.l4 - before.l4, '单次 blank-confirmed 不得触发 L4').toBe(0)
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, '可见态 L2 全程不 hide，收口后窗口应可见').toBe(true)
  })

  test('故障注入：parked 态 blank-confirmed 注入 → 状态机忽略，保持隐藏零动作', async () => {
    const before = await escalationCounts()
    await page.evaluate(() => (window as any).qihebox.window.hideToTray())
    await page.waitForFunction(() => !document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 10000 })
    // 迟到/竞态的 blank-confirmed（隐藏态到达）必须忽略——不得自行显示不得升级
    await app.evaluate(() => {
      ;(globalThis as any).__injectBlankConfirmed?.()
      return true
    })
    await page.waitForTimeout(800)
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, 'parked 态迟到 blank-confirmed 必须忽略（不得自行显示）').toBe(false)
    const after = await escalationCounts()
    expect(after.l2 - before.l2, 'parked 态 blank-confirmed 不得触发 L2').toBe(0)
    expect(after.l4 - before.l4, 'parked 态 blank-confirmed 不得触发 L4').toBe(0)
    // 收尾：恢复可见供后续用例
    await page.evaluate(() => (window as any).qihebox.window.show())
    await page.waitForFunction(() => !!document.querySelector('main[class*="overflow-y-auto"]'), null, { timeout: 20000 })
  })

  test('故障注入：渲染层 unresponsive → 状态机 hide + L2 reload → 收口可见', async () => {
    // unresponsive 事件注入（模拟 Chromium hang 判定——真实桌面由用户交互触发的 pending
    // input/合成帧超时产生；e2e 静止环境不检测，探针实证 2026-08-18）。本用例聚焦应用代码面：
    // unresponsive 事件 → 状态机 [hide, reload] → L2 → did-finish-load 收口 show（走
    // window.ts on('unresponsive') 同一监听链）。
    const before = await escalationCounts()
    await app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0]!.webContents
      wc.emit('unresponsive')
      return true
    })
    page = await waitBizMountedResilient(app, page, 60000)
    const after = await escalationCounts()
    expect(after.l2 - before.l2, 'unresponsive 应触发一次 L2 reload').toBe(1)
    const log = await readMainLog(app)
    expect(log, '日志应记录 unresponsive 判定').toMatch(/无响应|unresponsive/)
    const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
    expect(visible, 'L2 收口后窗口应可见').toBe(true)
  })

  test('故障注入：renderer crash → 状态机直接 L4 销毁重建 → ready-to-show 收口可见', async () => {
    // 崩溃模拟在 GitHub runner 时序不可靠（同 wake-recovery 崩溃用例先例；2026-08-19 CI 实测
    // L4 重建后 5s 挂载等待超时 + worker teardown 超时），本地真桌面完整验证
    test.skip(!!process.env.CI, '崩溃模拟在 GitHub runner 时序不可靠，本地真桌面完整验证')
    // 崩溃计数注意：本用例一次崩溃不达退出阈值（10 分钟 >3 次）
    const logBefore = await readMainLog(app)
    // visible 态直接崩溃渲染进程 → 状态机（renderer-gone → recovering → L4 销毁重建：
    // 崩溃后 webContents 损坏、loadFile 不可靠，2026-08-18 定案沿用）→ 新窗口 ready-to-show
    // 收口直接 show → 可见。
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.webContents.forcefullyCrashRenderer()
      return true
    })
    // 崩溃后渲染层重建（L4 新窗口），page 句柄失效，helper 重取窗口等业务层挂载
    page = await waitBizMountedResilient(app, page)
    // L4 重建后恢复链异步收敛（新窗口加载）：等待 1.5s 稳定，
    // 避免用例结束时状态未稳定污染后续用例（2026-08-18 批量实证：469 用例轮询失败）
    await page.waitForTimeout(1500)
    const log = await readMainLog(app)
    expect(countLogLines(log, /renderer gone/), '应记录渲染进程崩溃').toBeGreaterThan(countLogLines(logBefore, /renderer gone/))
    expect(log, '崩溃恢复应走状态机（L4 销毁重建）').toMatch(/L4 销毁重建/)
    // L4 新窗口 show 后 X11 映射异步（同 469 用例）：轮询 15s 覆盖映射 + 系统 suspend 恢复
    let visible = false
    for (let i = 0; i < 75; i += 1) {
      visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
      if (visible) break
      await new Promise((r) => setTimeout(r, 200))
    }
    expect(visible, '崩溃恢复后窗口应可见').toBe(true)
  })
})

// —— 主进程注入工具 ——

interface CapturePatchOpts {
  /** 前 N 次 capturePage 返回全白帧（1=首抓空白复检恢复；2=首抓+复检全白 → 白屏确认 L2） */
  blankN?: number
  /** 所有调用抛错（unknown：仅告警不升级——托盘冻结事故回归守卫） */
  throwAlways?: boolean
}

/** monkey-patch webContents.capturePage——走真实显示后自检链的故障注入 */
async function patchCapturePage(app: ElectronApplication, opts: CapturePatchOpts): Promise<void> {
  await app.evaluate(({ BrowserWindow, nativeImage }, cfg) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const wc = win.webContents
    const g = globalThis as any
    if (!g.__captureOrig) {
      g.__captureOrig = wc.capturePage.bind(wc)
    }
    // 1×1 全白 BGRA：isBlankFrameLike 的 blank 判定（全底色）与尺寸无关
    const fake = nativeImage.createFromBitmap(Buffer.alloc(4, 255), { width: 1, height: 1 })
    let calls = 0
    wc.capturePage = (async (...args: unknown[]) => {
      calls += 1
      if (cfg.blankN && calls <= cfg.blankN) return fake
      if (cfg.throwAlways) throw new Error('injected capturePage failure')
      return g.__captureOrig(...args)
    }) as typeof wc.capturePage
    return true
  }, opts)
}

async function restoreCapturePage(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as any
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return
    if (g.__captureOrig) win.webContents.capturePage = g.__captureOrig
    return true
  })
}
