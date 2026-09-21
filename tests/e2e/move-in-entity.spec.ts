/**
 * v2.5.9（A9 刀5b）：客户文件区里「移动到…」弹窗的**界面可达性**判据
 *
 * 刀5a 用单测钉住了主进程行为（`scope='customer'` 结构化目标能挪成），
 * 但**用户点不点得到**是另一件事——本 spec 钉的就是这一面：
 *   ① 在客户/供应商文件区里打开「移动到…」，看到的是**本实体**的形态：
 *      没有「去哪个产品集」、没有「图包 / 证书」二分，并有一行说明"只挪进本实体"；
 *   ② 目标列表 = 这个实体**盘上实际有**的子文件夹（含手工建的、含登记表里没有的）；
 *   ③ 选一个目标、确认，文件真的落到那个目录里（源目录不再有）。
 *
 * 反向证据：若把 `scope/entity` 两参从调用点撤掉（回到"产品集搬家"形态），
 * ①② 必红；若目标列表改回读全局模板表，② 必红（表里没有"归档"）。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test.describe('A9 刀5b · 客户内部挪动（界面可达性）', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string
  const CUSTOMER = '华东客户'
  const FROM = '沟通'
  const TO = '归档'
  /** 导入会按命名模板重命名（实测落成 `华东客户_沟通_合同扫描件_1.png`）⇒ 存盘后的真名 */
  let fileName = ''
  const FILE_HINT = '合同扫描件'

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('a9-move-entity') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-move-entity-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    // 一张待导入的源文件（放工作区外，模拟"从桌面选一个文件"）
    const src = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-move-src-')), '合同扫描件.png')
    await fsp.writeFile(src, 'png')

    await page.evaluate(async (name) => {
      await (window as any).qihebox.clients.create({ name })
    }, CUSTOMER)

    // 两个子文件夹：一个客户模板默认就有（报价），另两个本次现建（含一个表里没登记的）
    await page.evaluate(
      async ([name, from, to]) => {
        const qb = (window as any).qihebox
        await qb.files.createSubfolder({ product_set: name, file_type: '', name: from, scope: 'customer' })
        await qb.files.createSubfolder({ product_set: name, file_type: '', name: to, scope: 'customer' })
      },
      [CUSTOMER, FROM, TO] as const,
    )

    // 把一个文件导入「沟通」——之后要靠界面把它挪去「归档」
    await page.evaluate(
      async ([name, sub, srcPath]) => {
        const qb = (window as any).qihebox
        await new Promise((resolve) => {
          const unsub = qb.events.on('import:complete', (d: { success: boolean }) => {
            unsub()
            resolve(d)
          })
          void qb.files.import({
            source_paths: [srcPath],
            target_product_set: name,
            target_folder: '',
            target_type: '',
            sub_folder: sub,
            scope: 'customer',
          })
        })
      },
      [CUSTOMER, FROM, src] as const,
    )

    // 落盘真名（命名模板会改写文件名，不能拿源文件名去断言）
    const listed = await fsp.readdir(path.join(wsDir, '客户', CUSTOMER, FROM))
    fileName = listed.find((n) => n.includes(FILE_HINT)) ?? ''
    expect(fileName, `导入后 ${FROM} 里应有用命名模板改写过的文件：${listed}`).not.toBe('')
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('实体内「移动到…」：只有本实体的目标，且真的挪成', async () => {
    await page.evaluate((h) => {
      window.location.hash = h
    }, `/clients/${encodeURIComponent(CUSTOMER)}`)
    await expect(page.getByRole('heading', { name: CUSTOMER })).toBeVisible({ timeout: 15000 })

    // 文件在「沟通」tab 下：卡片应可见（文件名在卡里）
    // 文件在「沟通」tab 下：先切过去（客户页默认落在第一个 tab）
    await page.locator('.seg-item').filter({ hasText: new RegExp(`^${FROM}$`) }).click()
    const card = page.locator('.card').filter({ hasText: FILE_HINT }).first()
    await card.waitFor({ timeout: 20000 })

    // —— 打开右键菜单 → 移动到… ——
    await card.click({ button: 'right' })
        // 菜单项带图标（`📦移动到…`）⇒ 不能按 exact 文本匹配
    await page.locator('.row-btn').filter({ hasText: '移动到…' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 10000 })

    // ① 形态断言：客户域里「去哪个产品集」「图包/证书」两个问题都不成立 ⇒ 必须不存在
    await expect(page.getByLabel('移动到哪个产品集')).toHaveCount(0)
    await expect(dialog.getByText('图包', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('证书', { exact: true })).toHaveCount(0)
    await expect(dialog).toContainText(`只挪进${CUSTOMER}`)
    await expect(dialog).toContainText('自己盘上已有的子文件夹里')

    // ② 目标列表以盘为准：本实体盘上的目录（含模板默认项 + 本次现建的），
    //    且**不含**任何产品集名（旧形态会把"选产品集"列在这里）
    const targets = await dialog.locator('.seg-item').allTextContents()
    const clean = targets.map((t) => t.trim())
    expect(clean).toContain(TO)
    expect(clean).toContain(FROM)
    expect(clean).not.toContain('甲集')
    expect(clean.length).toBeGreaterThanOrEqual(3)

    // —— 选目标 + 确认 ——
    await dialog.locator('.seg-item').filter({ hasText: new RegExp(`^${TO}$`) }).click()
    await dialog.getByRole('button', { name: /移动\s*1\s*个/ }).click()

    // ③ 结果落到盘上：目标目录有、源目录没有
    await expect(async () => {
      await expect(fsp.stat(path.join(wsDir, '客户', CUSTOMER, TO, fileName))).resolves.toBeTruthy()
      await expect(fsp.stat(path.join(wsDir, '客户', CUSTOMER, FROM, fileName))).rejects.toBeTruthy()
    }).toPass({ timeout: 15000 })

    await expect(dialog).toHaveCount(0)
  })
})
