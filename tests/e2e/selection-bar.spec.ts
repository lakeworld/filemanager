import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 悬浮多选条（v2.5.8 D10 / 精致化 PLAN W5）行为回归。
 *
 * 收口前七页各写一条内嵌/悬浮横条，Esc 什么都不做；收口后统一为 `ui/SelectionBar`，
 * 本 spec 钉三件收口引入的新语义：
 *   1. **选中 → Esc → 清空选择并退场**（W5 用户拍板项）；
 *   2. **层栈次序不回归**：浮条之上再开弹窗时，第一次 Esc 只关弹窗、选择必须还在
 *      （两者都走 `ui/layerStack.ts` 的 `pushLayer`，弹窗后入栈即在栈顶，理应优先消费）；
 *   3. **浮条不遮最后一行**：有选中时列表容器才挂底部留白（`pb-24`），未选中态像素不变。
 *
 * 载体选发票台账一页就够：它是七处里动作最全的一条（全选可见 / 改状态 / 导出 / 批量删除），
 * 且「批量删除」正好会开 ConfirmDialog，天然满足第 2 条的构造。
 */
test.describe('悬浮多选条（v2.5.8 D10 / W5）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_USERDATA: e2eUserDataDirName('selection-bar'),
      },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
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

  /** 复位到无匹配空路由再进目标路由（照 selection-checkbox.spec 的既有口径，保证干净挂载） */
  const gotoRoute = async (route: string) => {
    await page.evaluate(() => {
      window.location.hash = '/__e2e-reset'
    })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate((r) => {
      window.location.hash = r
    }, route)
  }

  /** 建工作区 + 归档一张发票并建台账记录，返回临时目录以便收尾 */
  const seedInvoice = async (wsDir: string, number: string, amount: number): Promise<void> => {
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    const src = path.join(os.tmpdir(), `selbar-${number}.pdf`)
    await fsp.writeFile(src, '%PDF-1.4')
    const arc = await page.evaluate(
      async ({ fp, d }: { fp: string; d: string }) =>
        (window as any).qihebox.invoices.archiveFile(fp, d),
      { fp: src, d: '2026-08-10' },
    )
    expect(arc.success).toBe(true)
    await page.evaluate(
      async ({ fp, no, amt }: { fp: string; no: string; amt: number }) =>
        (window as any).qihebox.invoices.create({
          number: no,
          date: '2026-08-10',
          amount: amt,
          seller: '甲',
          buyer: '乙',
          status: '待报销',
          file_path: fp,
        }),
      { fp: arc.data, no: number, amt: amount },
    )
    await fsp.rm(src, { force: true }).catch(() => {})
  }

  const bar = () => page.getByRole('toolbar', { name: '批量操作' })

  test('选中 → Esc → 清空选择且浮条退场', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-selbar-esc-'))
    try {
      await seedInvoice(wsDir, 'SB-ESC-1', 88)
      await gotoRoute('/invoices')
      const card = page.getByTitle('金额 ¥88.00', { exact: true })
      await expect(card).toBeVisible({ timeout: 10000 })

      await card.click()
      const cb = page.getByRole('checkbox', { name: '选择发票 SB-ESC-1' })
      await expect(cb).toBeChecked()
      // 浮条文案：量词由页面给（张发票），组法住 lib/selectionBar.ts —— 与收口前逐字相同
      await expect(bar()).toBeVisible()
      await expect(page.getByText('已选择 1 张发票')).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(bar()).toHaveCount(0)
      await expect(cb).not.toBeChecked()
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('浮条之上开弹窗：第一次 Esc 只关弹窗且选择仍在，第二次 Esc 才清选择', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-selbar-layer-'))
    try {
      await seedInvoice(wsDir, 'SB-LAY-1', 66)
      await gotoRoute('/invoices')
      const card = page.getByTitle('金额 ¥66.00', { exact: true })
      await expect(card).toBeVisible({ timeout: 10000 })

      await card.click()
      await expect(bar()).toBeVisible()

      // 批量删除 → ConfirmDialog（它同样 pushLayer，后入栈即在栈顶）
      await page.getByRole('button', { name: /批量删除/ }).click()
      const dlg = page.getByRole('dialog', { name: '批量删除记录' })
      await expect(dlg).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)
      // ★ 关键断言：弹窗吃掉第一次 Esc，浮条与选择**必须原样还在**——
      //   若浮条先被消费，说明层栈次序反了（页面级监听抢在栈顶之前）
      await expect(bar()).toBeVisible()
      await expect(page.getByText('已选择 1 张发票')).toBeVisible()
      await expect(page.getByRole('checkbox', { name: '选择发票 SB-LAY-1' })).toBeChecked()

      await page.keyboard.press('Escape')
      await expect(bar()).toHaveCount(0)
      await expect(page.getByRole('checkbox', { name: '选择发票 SB-LAY-1' })).not.toBeChecked()
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('未选中态不给列表容器加底部留白；选中后加（防遮最后一行）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-selbar-pad-'))
    try {
      await seedInvoice(wsDir, 'SB-PAD-1', 99)
      await gotoRoute('/invoices')
      const card = page.getByTitle('金额 ¥99.00', { exact: true })
      await expect(card).toBeVisible({ timeout: 10000 })

      const gridHost = page.locator('[data-selection-bar-pad]')
      await expect(gridHost.first()).toBeVisible()
      // 未选中：不留白（否则等于白白吃掉 96px 视口，收口前就没有这段）
      await expect(gridHost.first()).not.toHaveClass(/pb-24/)

      await card.click()
      await expect(bar()).toBeVisible()
      await expect(gridHost.first()).toHaveClass(/pb-24/)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
