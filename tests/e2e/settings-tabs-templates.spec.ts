import { test, expect, _electron as electron } from '@playwright/test'
import { e2eUserDataDirName } from './helpers/launch'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const LABEL = 'settings-tabs-templates'
const userDataDir = (): string => path.join(os.tmpdir(), e2eUserDataDirName(LABEL))

/** 只取本 spec 断言用到的列（其余原样保留，不做形状校验——那是单测的事） */
interface ConfigShape {
  image_subfolders: string[]
  cert_subfolders: string[]
  doc_subfolders: string[]
  customer_subfolders: string[]
  supplier_subfolders: string[]
  custom_templates?: { id: string; name: string; image_subfolders: string[] }[]
}

/**
 * 设置页分页 + 行业文件夹模板 + 新建弹窗引导（v2.6.1）端到端。
 *
 * 四条都走**真链路**（真 Electron、真 IPC、真磁盘 config.json），禁 mock：
 *  ① 切页签：卡片随页签显隐、URL 跟到 `?tab=`（默认「通用」不变）；
 *  ② 点模板 = 只改草稿：徽标/选中态立刻变，**磁盘不动**；按「保存设置」后 config.json 五张清单真变；
 *  ③ 新建产品集弹窗：A 版提示块逐字 + 三清单预览 + placeholder 跟模板 + 链接真跳「文件夹模板」页签；
 *  ④ 自定义模板「新增（存当前清单）→ 保存落文件 → 删除 → 保存清掉」往返。
 * （执行序 ③ 在 ④ 前：④ 要先把草稿改成"哪套内置都不全等"，会让 ③ 的模板名断言（外贸）失去前提。）
 *
 * 目标在这些条之外的东西不测（不重复单测已钉的词表/判定；弹窗引导的存量实体零触碰由 ② 的
 * "保存前磁盘不动" 与单测共同把住）。
 */
test.describe('设置页分页 + 行业文件夹模板 + 新建弹窗引导（v2.6.1）', () => {
  test.describe.configure({ mode: 'serial' })

  let app: ElectronApplication
  let page: Page
  let wsDir = ''

  const readConfig = async (): Promise<ConfigShape> =>
    JSON.parse(await fsp.readFile(path.join(wsDir, '.qihefilemanager', 'config.json'), 'utf-8')) as ConfigShape

  const goto = async (hashPath: string): Promise<void> => {
    await page.evaluate((h) => {
      window.location.hash = h
    }, hashPath)
  }
  const hash = (): Promise<string> => page.evaluate(() => window.location.hash)
  /** 保存钮在成功后会短暂显示「已保存 ✓」（2s），两次保存可能落在窗口内 ⇒ 名字按两态一起匹配 */
  const saveBtn = () => page.getByRole('button', { name: /保存设置|已保存/ })

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1', QIHEBOX_E2E_USERDATA: e2eUserDataDirName(LABEL) },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-settings-tabs-'))
    const create = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(create.success).toBe(true)
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
    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(userDataDir(), { recursive: true, force: true }).catch(() => {})
  })

  test('① 切页签：卡片随页签显隐，URL 跟到 ?tab=（默认「通用」）', async () => {
    await goto('/settings')
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible({ timeout: 10000 })
    // 默认页签 = 通用：应用级设置与台账入口在，别的页签的卡片不在
    await expect(page.getByText('关闭主窗口时驻留托盘')).toBeVisible()
    await expect(page.getByRole('heading', { name: '台账入口' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '图包子文件夹' })).toHaveCount(0)
    expect(await hash()).not.toContain('tab=folders')

    await page.getByRole('button', { name: '文件夹模板' }).click()
    await expect(page.getByRole('heading', { name: '文件夹模板' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '图包子文件夹' })).toBeVisible()
    await expect(page.getByRole('button', { name: '文件夹模板' })).toHaveClass(/seg-item-on/)
    await expect(page.getByRole('heading', { name: '台账入口' })).toHaveCount(0)
    expect(await hash()).toContain('tab=folders')

    await page.getByRole('button', { name: '标签' }).click()
    await expect(page.getByRole('heading', { name: '标签管理' })).toBeVisible()
    expect(await hash()).toContain('tab=tags')

    await page.getByRole('button', { name: '高级' }).click()
    await expect(page.getByRole('heading', { name: '命名模板' })).toBeVisible()
    expect(await hash()).toContain('tab=advanced')

    // 切页签不丢草稿：回「文件夹模板」，五张清单与模板卡都还在
    await page.getByRole('button', { name: '文件夹模板' }).click()
    await expect(page.getByRole('heading', { name: '文件夹模板' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '图包子文件夹' })).toBeVisible()
  })

  test('② 点模板 = 只改草稿：徽标/选中态变 + 保存后 config.json 真变', async () => {
    await goto('/settings?tab=folders')
    await expect(page.getByRole('heading', { name: '文件夹模板' })).toBeVisible({ timeout: 10000 })
    // 新工作区 = 电商默认 ⇒ 徽标「当前：电商」+ 电商卡选中态（派生自 matchTemplate，不落 config）
    await expect(page.getByText(/当前：电商/)).toBeVisible()
    await expect(page.locator('[data-template="电商"]')).toHaveClass(/card-selected/)

    // 未保存前磁盘一字不动（点模板只进草稿）
    expect((await readConfig()).image_subfolders).toEqual(['主图', '详情页', '白底图', '素材'])

    await page.locator('[data-template="外贸"]').getByRole('button', { name: '用这套' }).click()
    await expect(page.getByText(/当前：外贸/)).toBeVisible()
    await expect(page.locator('[data-template="外贸"]')).toHaveClass(/card-selected/)
    expect((await readConfig()).image_subfolders).toEqual(['主图', '详情页', '白底图', '素材'])

    await saveBtn().click()
    await expect.poll(async () => (await readConfig()).image_subfolders.join('/')).toBe('产品图/包装设计/宣传素材')
    const after = await readConfig()
    expect(after.cert_subfolders).toEqual(['认证', '检测报告', '授权'])
    expect(after.doc_subfolders).toEqual(['报关资料', '装箱单', '合同'])
    expect(after.customer_subfolders).toEqual(['报价', '合同', '单证', '沟通'])
    expect(after.supplier_subfolders).toEqual(['合同', '对账单', '出货文件'])
    await expect(page.getByText(/当前：外贸/)).toBeVisible()
  })

  test('③ 新建产品集弹窗：A 版提示块 + 三清单预览 + 链接关弹窗跳「文件夹模板」页签', async () => {
    await goto('/product-sets')
    await page.getByRole('button', { name: '新建产品集' }).first().click()
    const dlg = page.locator('[role="dialog"][aria-label="新建产品集"]')
    await expect(dlg).toBeVisible({ timeout: 10000 })

    // A 版逐字（模板名 = 当前命中的「外贸」，② 刚保存过）
    await expect(dlg.getByText(/文件夹名按当前模板（外贸）生成/)).toBeVisible()
    await expect(dlg.getByText(/换一套或自己改——只影响以后新建的产品集/)).toBeVisible()
    // 三清单预览来自命中模板
    await expect(dlg.getByText(/会建：图包〔产品图 · 包装设计 · 宣传素材〕证书〔认证 · 检测报告 · 授权〕/)).toBeVisible()
    await expect(dlg.getByText(/文档〔报关资料 · 装箱单 · 合同〕/)).toBeVisible()
    // placeholder 跟模板：外贸没给例 ⇒ 回通用例（电商例见 create-prefill.spec）
    await expect(dlg.locator('input[placeholder="如：产品/项目名称"]')).toHaveCount(1)

    // 链接不是纯文本：真关弹窗、真落「文件夹模板」页签
    await dlg.getByRole('button', { name: /文件夹模板/ }).click()
    await expect(dlg).toHaveCount(0, { timeout: 10000 })
    expect(await hash()).toContain('/settings?tab=folders')
    await expect(page.getByRole('heading', { name: '文件夹模板' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '图包子文件夹' })).toBeVisible()
    await expect(page.getByRole('button', { name: '文件夹模板' })).toHaveClass(/seg-item-on/)
  })

  test('④ 自定义模板：新增（存当前清单）→ 保存落文件 → 删除 → 保存清掉', async () => {
    await expect(page.getByRole('heading', { name: '图包子文件夹' })).toBeVisible({ timeout: 10000 })
    // 先手改一张清单：否则"存当前清单"出来的五列与内置「外贸」全等，徽标按"内置优先"仍显示外贸
    await page.locator('input[placeholder="新增子文件夹名称"]').fill('自定义夹')
    await page.getByRole('button', { name: '添加' }).first().click()
    await expect(page.getByText(/当前：自定义/)).toBeVisible()

    await page.getByRole('button', { name: '＋ 新增模板（存当前清单）' }).click()
    const nameInput = page.getByLabel('模板名称')
    await nameInput.fill('我们自己的分类')
    await nameInput.press('Enter')
    await expect(page.locator('[data-template="我们自己的分类"]')).toBeVisible()
    await expect(page.getByText(/当前：我们自己的分类/)).toBeVisible()
    // 未保存：磁盘上没有这个键（新键缺省 = 不落盘）
    expect((await readConfig()).custom_templates ?? []).toEqual([])

    await saveBtn().click()
    await expect.poll(async () => (await readConfig()).custom_templates?.length ?? 0).toBe(1)
    const saved = await readConfig()
    expect(saved.custom_templates![0].id).toBe('custom:我们自己的分类')
    // 「存当前清单」= 逐列等于当时草稿（不只是名字存下来了）
    expect(saved.custom_templates![0].image_subfolders).toEqual(saved.image_subfolders)

    // 删除要过 ConfirmDialog；删完再保存，磁盘上的键跟着清掉
    await page.locator('[data-template="我们自己的分类"]').getByRole('button', { name: '删除' }).click()
    const confirm = page.getByRole('dialog')
    await expect(confirm).toBeVisible()
    await confirm.getByRole('button', { name: '删除' }).click()
    await expect(page.locator('[data-template="我们自己的分类"]')).toHaveCount(0)
    await saveBtn().click()
    await expect.poll(async () => (await readConfig()).custom_templates?.length ?? 0).toBe(0)
  })
})