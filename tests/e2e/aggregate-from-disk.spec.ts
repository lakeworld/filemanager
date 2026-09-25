/**
 * v2.5.9（A9 刀1d）：聚合页（图包库 / 证书库）**以盘为准** 的端到端判据
 *
 * 用户视角的变化（这条用例就是钉它别悄悄回退）：
 *   旧行为：聚合页只列「设置 → 子文件夹」模板表里登记过的目录 ⇒ 用户在产品集里手工建的
 *           （或网盘同步进来的）证书目录，**里面的证书在证书库里永远看不见**。
 *   新行为：聚合页按每个产品集**盘上实际有**的目录去取 ⇒ 那些证书开始出现。
 *
 * ⚠ 这是 A9 里唯一一处"用户会突然看见新东西"的改动：本 spec 的存在就是为了让这个变化
 *   有据可查（`HELP.md` 的公开承诺已同步改写），并且将来谁想改回"只聚合登记过的"必须面对这条红。
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import { expectOptionExists } from './helpers/searchSelect'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test.describe('A9 刀1d · 聚合页以盘为准', () => {
  let app: ElectronApplication
  let page: Page
  let wsDir: string
  /** 模板表里**没有**、但盘上真实存在的证书目录名 */
  const UNREGISTERED = '客户特供'

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName('a9-aggregate-disk') },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 15000 })

    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-agg-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => {
      const qb = (window as any).qihebox
      await qb.productSets.create({ name: '甲集' })
      await qb.productSets.create({ name: '乙集' })
    })

    // 甲集：一个**未登记**的证书目录 + 一份证书（PDF 即可，聚合页按文件名/路径列）
    await page.evaluate(
      async (name) => {
        await (window as any).qihebox.files.createSubfolder({
          product_set: '甲集', file_type: 'cert', name, scope: 'productSet',
        })
      },
      UNREGISTERED,
    )
    const src = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-agg-src-')), '特供证书.pdf')
    await fsp.writeFile(src, 'pdf')
    await page.evaluate(
      async ([name, srcPath]) => {
        await new Promise((resolve) => {
          const qb = (window as any).qihebox
          const unsub = qb.events.on('import:complete', (d: { success: boolean }) => {
            unsub()
            resolve(d)
          })
          void qb.files.import({
            source_paths: [srcPath],
            target_product_set: '甲集',
            target_folder: name,
            target_type: 'cert',
            sub_folder: name,
          })
        })
      },
      [UNREGISTERED, src] as const,
    )

    // 反向锚点：确认模板表里真的没有它（否则本用例什么也没证明）
    const cfg = await page.evaluate(async () => (window as any).qihebox.config.get())
    expect(cfg.success).toBe(true)
    expect(cfg.data.cert_subfolders ?? []).not.toContain(UNREGISTERED)
  })

  test.afterAll(async () => {
    await app?.close().catch(() => {})
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('证书库：未登记目录里的证书也出现（且筛选下拉里有它）', async () => {
    await page.evaluate(() => {
      window.location.hash = '/certs'
    })
    await expect(page.getByRole('heading', { name: '证书库' })).toBeVisible({ timeout: 20000 })

    // ① 那条证书本身出现在列表里（旧行为下永远看不见）
    await expect(page.getByText('特供证书').first()).toBeVisible({ timeout: 20000 })

    // ② 子文件夹筛选下拉里有这个目录（并集来自盘，不来自模板表）
    //    收起态时弹层**整个不在 DOM**（见 helpers/searchSelect.ts 头注）——旧写法把断言包在
    //    `count() > 0` 里，而 count 恒为 0 ⇒ 这条承诺一次都没执行过（2026-09-25 测试反推审查 §三.1）。
    //    现改为无条件开面板断言：下拉不在 / 选项缺了 / 面板打不开，都当场红。
    await expectOptionExists(page, page.getByLabel('子文件夹筛选'), UNREGISTERED)
  })

  test('图包库同理：未登记的图包子目录里的图也出现', async () => {
    // 再造一个未登记的图包子文件夹 + 一张图，验图包库不是只对证书生效
    const UNREG_IMG = '直播截图'
    await page.evaluate(
      async (name) => {
        await (window as any).qihebox.files.createSubfolder({
          product_set: '乙集', file_type: 'image', name, scope: 'productSet',
        })
      },
      UNREG_IMG,
    )
    const sharp = (await import('sharp')).default
    const srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-a9-agg-img-src-'))
    const src = path.join(srcDir, '直播图.png')
    await sharp({ create: { width: 60, height: 60, channels: 3, background: { r: 9, g: 9, b: 9 } } })
      .png()
      .toFile(src)
    await page.evaluate(
      async ([name, srcPath]) => {
        await new Promise((resolve) => {
          const qb = (window as any).qihebox
          const unsub = qb.events.on('import:complete', (d: { success: boolean }) => {
            unsub()
            resolve(d)
          })
          void qb.files.import({
            source_paths: [srcPath],
            target_product_set: '乙集',
            target_folder: name,
            target_type: 'image',
            sub_folder: name,
          })
        })
      },
      [UNREG_IMG, src] as const,
    )
    await fsp.rm(srcDir, { recursive: true, force: true }).catch(() => {})

    await page.evaluate(() => {
      window.location.hash = '/images'
    })
    await expect(page.getByRole('heading', { name: '图包库' })).toBeVisible({ timeout: 20000 })
    await expect(page.getByText('直播图').first()).toBeVisible({ timeout: 20000 })
  })
})
