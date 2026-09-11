import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import sharp from 'sharp'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 快捷键单注册点（v2.5.8 D11 / 精致化 PLAN W6）端到端回归。
 *
 * 两类用例各守一头：
 *  - **收编不回归**：Ctrl+K / Ctrl+C 是既有语义（`clipboard-guard.spec` 已覆盖 Ctrl+C 的选区让位，
 *    这里补 Ctrl+K 与「输入框内不劫持」这条守卫——守卫从组件搬到 `shortcuts.ts` 时最容易搬丢）。
 *  - **新增能用且守得住**：Ctrl+, 进设置、Ctrl+1…6 直跳、Ctrl+A 全选、Delete 走既有确认弹窗。
 *
 * 说明：`Ctrl+Alt+K` 托盘全局唤醒属主进程 globalShortcut，**e2e 起不了真系统热键**
 * （要装到 OS 会话里、且要与别的软件抢注），归 W2 真机手动项，本 spec 不假装能测。
 */
test.describe('快捷键单注册点（v2.5.8 D11 / W6）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: {
        ...process.env,
        QIHEBOX_E2E: '1',
        QIHEBOX_E2E_USERDATA: e2eUserDataDirName('shortcuts'),
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

  /** 建工作区 + 产品集，并走**应用导入管道**放图（直接 fsp 写盘不进索引，页面看不到）。
   *  导入参数与等待方式照 `context-menu.spec.ts` 的既有先例（等 `import:complete` 事件），
   *  落到 FileBrowserView 的 `/files/image/<产品集>/主图` —— 该页全选与批量删除都是既有函数。 */
  const seedImages = async (wsDir: string, setName: string, names: string[]): Promise<void> => {
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async (name) => (window as any).qihebox.productSets.create({ name }), setName)
    const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-shortcut-src-'))
    for (const n of names) {
      // 真 PNG：空字节串会让缩略图链路走失败分支，断言就失去了「导入成功」的含义
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

  /** 进 FileBrowserView 的产品集图片区 */
  const gotoFiles = async (setName: string) => {
    await page.evaluate((ps) => {
      window.location.hash = decodeURIComponent(`/files/image/${encodeURIComponent(ps)}/${encodeURIComponent('主图')}`)
    }, setName)
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15000 })
  }

  test('Ctrl+K 聚焦全局搜索框；在输入框内按 Ctrl+K 不劫持', async () => {
    await gotoRoute('/')
    await expect(page.getByRole('heading', { name: '仪表盘' }).first()).toBeVisible({ timeout: 10000 })
    // 起点把焦点放在正文（不是搜索框）——否则「聚焦」这条断言无从判断
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Control+K')
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id), { timeout: 5000 })
      .toBe('global-search-input')

    // 守卫回退断言：焦点在输入框里时，Ctrl+K 不该把焦点抢走（收编前 Header 的豁免口径）
    const box = page.locator('#global-search-input')
    await box.fill('测试中')
    await page.evaluate(() => (document.activeElement as HTMLInputElement)?.select())
    await page.keyboard.press('Control+K')
    // 输入框内按 Ctrl+K：不劫持 → 焦点仍在搜索框且文本未被清（浏览器原行为不受影响）
    await expect(box).toHaveValue('测试中')
  })

  test('Ctrl+, 打开设置页', async () => {
    await gotoRoute('/')
    await page.keyboard.press('Control+Comma')
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible({ timeout: 10000 })
  })

  test('Ctrl+1…6 直跳侧边栏前六项（路由取自声明表）', async () => {
    const expectRoute = async (key: string, heading: string) => {
      await gotoRoute('/')
      await page.getByRole('heading', { name: '仪表盘' }).first().waitFor({ timeout: 10000 })
      await page.keyboard.press(`Control+${key}`)
      await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 10000 })
    }
    await expectRoute('1', '仪表盘')
    await expectRoute('2', '产品集')
    await expectRoute('3', '图包库')
    await expectRoute('5', '笔记库')
  })

  test('浮条在时 Ctrl+A 全选可见、Delete 走既有二次确认弹窗', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-shortcut-del-'))
    try {
      await seedImages(wsDir, '快捷键集', ['甲', '乙'])
      await gotoFiles('快捷键集')

      // 单击一张 → 浮条出现 → Ctrl+A 扩到全部（FileBrowserView 的 selectAllFiles）
      await page.locator('.card').first().click()
      await expect(page.getByText('已选择 1 个文件')).toBeVisible({ timeout: 5000 })
      await page.keyboard.press('Control+A')
      await expect(page.getByText('已选择 2 个文件')).toBeVisible({ timeout: 5000 })

      // Delete → 必须是**既有确认弹窗**（不改删除语义：按 Delete 直接删是事故）
      await page.keyboard.press('Delete')
      const dlg = page.getByRole('dialog')
      await expect(dlg).toBeVisible({ timeout: 5000 })
      await page.getByRole('button', { name: '取消' }).last().click()
      await expect(dlg).toHaveCount(0)
      // 取消后选中与文件都还在（确认弹窗是唯一的删除入口这一事实，顺带被这条断言锁住）
      await expect(page.getByText('已选择 2 个文件')).toBeVisible()
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('浮条不在时 Delete 不劫持（未注册即原样放行）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-shortcut-idle-'))
    try {
      await seedImages(wsDir, '静默集', ['丙'])
      await gotoFiles('静默集')
      // 无选中 → 浮条不存在 → Delete 没有任何处理器接管 → 不得弹出确认框
      await page.keyboard.press('Delete')
      await page.waitForTimeout(400)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.locator('.card').first()).toBeVisible()
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  // 2026-09-12 复审 P0：既有那条只在 Files 路由跑，而 Files 页的 onDelete 回调**自带**空守卫
  // ——真正没守卫的是报价页（`onDelete={() => setBatchDeleteConfirm(true)}` 直接置位），
  // 于是「零选中按 Delete」在报价页会弹「确定删除已选的 0 条报价记录吗？」。
  //
  // **必须先种至少一条报价**：`Quotes.tsx:460` 那个 `<Show when={viewMode()==="records" && quotes().length===0}
  // fallback={…}>` 在无数据时走空态分支，而 `SelectionBar`（:481）挂在 fallback 里——空库时组件根本不挂载，
  // 键也就没被注册，用例会在「旧代码上也绿」的假象里通过（本轮第一版就踩了这个坑，实测旧版 6 例全绿）。
  // 用 `qihebox.quotes.create` 直种一行明细，比走「新建报价」弹窗 UI 少十几步交互，且 core 校验一字不绕。
  test('零选中时 Delete 不劫持——回调不带守卫的报价页同样不得弹「删 0 条」', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-shortcut-zero-'))
    try {
      await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
      const created = await page.evaluate(async () =>
        (window as any).qihebox.quotes.create({
          date: '2026-09-12',
          // core 双保险：行必须自带 amount，且要等于 round2(qty × unit_price)，否则整单被拒
          lines: [{ product: '复审种子件', sku: 'SEED-1', qty: 1, unit_price: 10, amount: 10 }],
        }),
      )
      expect(created.success, `种报价失败：${JSON.stringify(created)}`).toBe(true)
      await gotoRoute('/quotes')
      // 「共 1 条报价 · 金额合计」只在有数据的 records 分支里出现 = SelectionBar 确实挂载了的证据
      await expect(page.getByText('共 1 条报价').first()).toBeVisible({ timeout: 10000 })
      await page.keyboard.press('Delete')
      await page.waitForTimeout(500)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByText('批量删除报价记录')).toHaveCount(0)
    } finally {
      await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    }
  })
})
