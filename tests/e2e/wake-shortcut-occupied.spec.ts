import { WAKE_SEARCH_ACCELERATOR_LABEL } from '../../src/shared/appSettings'
import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * A6-1 全局唤醒快捷键「注册失败要如实降级」的端到端判据（内部设计文档 A6-1 验收原句：
 * 设置页显示「被占用」+ 开关可再试）。
 *
 * 为什么需要专门一条：本批 A6-1 原先只做到"主进程 log 一句 warn"，评审 Spec 轴抓到
 * **界面那一半没做**——而设置页的开关是受控于磁盘值的，不退回就会长期显示"已开启"、
 * 系统里却什么都没注册，正是 PLAN 点名要防的「按不动的开关」。
 *
 * 真实"热键被别的程序占用"在 CI 与本机都造不出来，所以主进程留了一条**双开关门控**的测试缝
 * （`QIHEBOX_E2E=1` 且 `QIHEBOX_E2E_FAIL_WAKE=1` 才让 `globalShortcut.register` 返回 false，
 * 见 `src/main/index.ts` 的 `wakePort.register`）；生产路径不可达。
 * 反过来这条 spec 也顺带钉住"缝不会漏"：不开第二个开关时，产品行为与本 spec 无关。
 */
test.describe('A6-1 唤醒快捷键占用时的如实降级', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  test.beforeAll(async () => {
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-wake-occupied-'))
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_FAIL_WAKE: '1', // 模拟占用
        QIHEBOX_E2E_USERDATA: e2eUserDataDirName('wake-occupied'),
      },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
  })

  test.afterAll(async () => {
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    if (app) {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch {
          /* 已退出 */
        }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
  })

  const wakeCheckbox = () =>
    page.locator('label', { hasText: '全局唤醒搜索' }).locator('input[type="checkbox"]')

  test('点开后注册失败：开关必须弹回关、磁盘值必须仍是 false、页面必须说"占用"', async () => {
    await page.evaluate(() => {
      window.location.hash = decodeURIComponent('/settings')
    })
    const box = wakeCheckbox()
    await expect(box).toBeVisible({ timeout: 15000 })
    expect(await box.isChecked(), '前置：默认应为关（A6-1 默认关是 PLAN 口径）').toBe(false)

    await box.click()
    await page.waitForTimeout(800)

    // ① 界面：说清楚为什么（不是只让开关自己跳回去）
    // 判据必须咬**我们自己的那句文案**：早先写 `p:has-text("占用")` 是空断言——
    // 反向实验里退回逻辑被接死了它却仍然通过（页面上另有带"占用"字样的段落撞上），
    // 是反向实验抓出来的，不是我想出来的。
    await expect(
      page.getByText(`未能注册：${WAKE_SEARCH_ACCELERATOR_LABEL} 可能已被系统或其它程序占用`),
      '注册失败却没在设置页说明 ⇒ 用户只看到一个自己弹回的开关',
    ).toBeVisible({ timeout: 5000 })
    // ② 开关：必须回到关（=可再试，而不是灰在那儿）
    expect(await box.isChecked(), '未能注册却仍显示"已开启"＝按不动的开关').toBe(false)
    await expect(box, '开关必须还能再点（PLAN：开关可再试）').toBeEnabled()
    // ③ 持久层：主进程必须真的退回了，而不是只改了显示
    const persisted = await page.evaluate(async () => {
      const r = await (window as any).qihebox.appSettings.get()
      return (r.data ?? r).globalWakeShortcut as boolean
    })
    expect(persisted, '磁盘上还写着 true ⇒ 重启后设置页仍在撒谎').toBe(false)
  })
})
