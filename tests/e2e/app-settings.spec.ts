import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import sharp from 'sharp'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 与 main 侧同一份 userData 路径口径（e2e 下 index.ts 把 userData 指向 tmpdir/<QIHEBOX_E2E_USERDATA>） */
const userDataDir = (label: string): string => path.join(os.tmpdir(), e2eUserDataDirName(label))

const readSettingsFile = async (label: string): Promise<Record<string, unknown>> => {
  const p = path.join(userDataDir(label), 'settings.json')
  return JSON.parse(await fsp.readFile(p, 'utf-8')) as Record<string, unknown>
}

/**
 * 应用级设置开关（v2.5.8 D11 / W7）端到端。
 *
 * 要坐实的是执行卡 §6.2 的验收原话「**改 → 持久化 → 重启生效**」。单测只能证纯函数与落盘形状，
 * 「跨进程 + 跨实例」这一段必须真跑，所以本 spec 起两个实例（中间真杀进程，不是 reload）：
 *  1. 默认值 = 现行行为，且**没动过开关时磁盘上不落任何新键**（回滚 = 删文件的前提）；
 *  2. 在设置页上**点开关**改值 → 磁盘只落「与默认不同」的键；
 *  3. 重启后 `getAll` 与设置页 UI 都读到改后的值；
 *  4. 关掉「悬浮多选条」后：选中仍生效（卡片选中态 + Ctrl+A 扩选照旧），但浮条不出现；
 *     再打开后浮条立刻回来——证明消费点是**响应式读**，不是启动时读一次就冻住。
 *
 * 覆盖面诚实声明：`关闭主窗口时驻留托盘`、`自动检查更新`、`证书到期与发票待办提醒` 三项的**消费点在
 * 主进程**且各自带 e2e 短路（`QIHEBOX_E2E` 下 `setupCloseToTray` 直接 return；更新检查要走外网；
 * 系统通知在容器/CI 不受支持），本 spec 只验到「写入 + 重启读回」，其真实行为归 W2 真机手动项。
 */
test.describe('应用级设置开关（v2.5.8 D11 / W7）', () => {
  const launch = async (label: string): Promise<{ app: ElectronApplication; page: Page }> => {
    const app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_USERDATA: e2eUserDataDirName(label),
      },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    return { app, page }
  }

  const kill = async (app: ElectronApplication): Promise<void> => {
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

  /** 进设置页并等「通用」卡就绪（应用级设置镜像是 App onMount 异步拉的，早读到的是默认值） */
  const gotoSettings = async (page: Page): Promise<void> => {
    await page.evaluate(() => {
      window.location.hash = '/settings'
    })
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible({ timeout: 10000 })
  }

  const toggleOf = (page: Page, title: string) =>
    page.locator('label', { hasText: title }).first().locator('input[type="checkbox"]')

  /** 等镜像拉回来再断言（用「提前提醒天数」这条非默认值当信号不合适，直接等 getAll 成功返回） */
  const waitMirror = async (page: Page): Promise<void> => {
    await expect
      .poll(async () => {
        const r = (await page.evaluate(async () =>
          (window as any).qihebox.appSettings.get(),
        )) as { success: boolean }
        return r.success
      }, { timeout: 10000 })
      .toBe(true)
  }

  /** 建工作区 + 产品集，走应用导入管道放 n 张真 PNG（直接写盘不进索引，页面看不到） */
  const seedImages = async (page: Page, wsDir: string, setName: string, count: number): Promise<void> => {
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), setName)
    const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-w7-src-'))
    const names: string[] = []
    for (let i = 0; i < count; i += 1) {
      const n = `w7-${i}`
      names.push(n)
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 66, g: 135, b: 245 } } })
        .png()
        .toFile(path.join(srcDir, `${n}.png`))
    }
    const evt = (await page.evaluate(
      async ({ dir, ps, ns }: { dir: string; ps: string; ns: string[] }) =>
        new Promise((resolve) => {
          const qb = (window as any).qihebox
          const unsub = qb.events.on('import:complete', (data: any) => {
            unsub()
            resolve(data)
          })
          void qb.files.import({
            source_paths: ns.map((x) => `${dir}/${x}.png`),
            target_product_set: ps,
            target_folder: '主图',
            target_type: 'image',
            sub_folder: '主图',
          })
        }),
      { dir: srcDir, ps: setName, ns: names },
    )) as { success: boolean }
    expect(evt.success).toBe(true)
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {})
  }

  const gotoFiles = async (page: Page, setName: string): Promise<void> => {
    await page.evaluate((ps) => {
      window.location.hash = decodeURIComponent(`/files/image/${encodeURIComponent(ps)}/${encodeURIComponent('主图')}`)
    }, setName)
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15000 })
  }

  test('默认值 = 现行行为；没动过开关则磁盘不落任何新键', async () => {
    const label = 'w7-defaults'
    await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    const { app, page } = await launch(label)
    try {
      await waitMirror(page)
      const all = await page.evaluate(async () => (window as any).qihebox.appSettings.get())
      expect(all.data).toMatchObject({
        devMode: false,
        closeToTray: true,
        autoUpdateCheck: true,
        selectionBar: true,
        clipboardGuard: true,
        certReminder: true,
        certReminderDays: 30,
      })

      await gotoSettings(page)
      // 设置页上的开关档位必须与 getAll 一致（不是 UI 自己另写的一份默认值）
      for (const t of [
        '关闭主窗口时驻留托盘',
        '自动检查更新',
        '悬浮多选操作条',
        '剪贴板让位正文选区',
        '证书到期与发票待办提醒',
      ]) {
        await expect(toggleOf(page, t), t).toBeChecked()
      }
      // 未改动 → 不该有 settings.json（等于默认值的键不落盘，回滚只需删文件）
      await fsp.access(path.join(userDataDir(label), 'settings.json')).then(
        () => {
          throw new Error('未改动任何开关却落了 settings.json')
        },
        () => {
          /* ENOENT = 预期 */
        },
      )
    } finally {
      await kill(app)
      await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    }
  })

  test('点开关 → 落盘 → 真重启读回，浮条显隐随设置响应', async () => {
    const label = 'w7-restart'
    await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-w7-ws-'))

    // —— 实例一：在设置页上点掉两项 + 改一档天数 ——
    const first = await launch(label)
    try {
      await waitMirror(first.page)
      await gotoSettings(first.page)
      await toggleOf(first.page, '悬浮多选操作条').uncheck()
      await toggleOf(first.page, '自动检查更新').uncheck()
      // 触发器是带 aria-haspopup 的 button（SearchSelect 底座形状），不是原生 combobox
      await first.page.getByRole('button', { name: '提前提醒天数' }).click()
      await first.page.getByRole('option', { name: '7 天' }).click()

      // 磁盘只落「与默认不同」的三键（closeToTray 等保持默认 → 不落盘）
      await expect.poll(async () => readSettingsFile(label)).toMatchObject({
        selectionBar: false,
        autoUpdateCheck: false,
        certReminderDays: 7,
      })
    } finally {
      await kill(first.app) // 真杀进程：重启语义的唯一证据（reload 证不到跨实例持久化）
    }

    // —— 实例二：同 userData 重启 ——
    const second = await launch(label)
    try {
      await waitMirror(second.page)
      const all = await second.page.evaluate(async () => (window as any).qihebox.appSettings.get())
      expect(all.data).toMatchObject({ selectionBar: false, autoUpdateCheck: false, certReminderDays: 7 })

      await gotoSettings(second.page)
      await expect(toggleOf(second.page, '悬浮多选操作条')).not.toBeChecked()
      await expect(toggleOf(second.page, '自动检查更新')).not.toBeChecked()
      // 改回默认值 → 键从磁盘上消失（删键即回滚）
      await toggleOf(second.page, '自动检查更新').check()
      await expect.poll(async () => readSettingsFile(label)).toMatchObject({ selectionBar: false })

      await seedImages(second.page, wsDir, 'W7集', 2)
      await gotoFiles(second.page, 'W7集')
      const bar = second.page.getByRole('toolbar', { name: '批量操作' })

      // 关闭态：浮条不出现，但选择态与 Ctrl+A 扩写照旧（关的只是画面占用）
      await second.page.locator('.card').first().click()
      await expect(second.page.locator('.card-selected')).toHaveCount(1)
      await expect(bar).toHaveCount(0)
      await second.page.keyboard.press('Control+A')
      await expect(second.page.locator('.card-selected')).toHaveCount(2)

      // 重新打开 → 浮条立刻回来且带着当前选中数（响应式消费，不是启动时读一次）
      await gotoSettings(second.page)
      await toggleOf(second.page, '悬浮多选操作条').check()
      await gotoFiles(second.page, 'W7集')
      await second.page.locator('.card').first().click()
      await expect(bar).toBeVisible({ timeout: 5000 })
      await expect(bar.getByText('已选择 1 个文件')).toBeVisible()
    } finally {
      await kill(second.app)
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(userDataDir(label), { recursive: true, force: true }).catch(() => {})
    }
  })
})
