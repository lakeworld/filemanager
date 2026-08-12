import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 客户维度 e2e（v2.4.7，PLAN §十）：
 * - 新建 → 默认子文件夹 → 子文件夹导入（scope='customer'）→ 列表/详情
 * - 全局搜索命中客户与客户区文件
 * - 删除 → 回收站（kind='customer'）→ 恢复 → 列表复原
 * 客户详情路由 /clients/:name 的 UI 渲染单独一例（reload 后经应用启动流同步 currentWorkspace）。
 */
test.describe('客户维度 e2e（v2.4.7）', () => {
  let app: ElectronApplication
  let page: Page
  /** 应用初始入口 URL（file:// index.html）；既有测试 pushState 会改 history URL，
   *  后续 reload() 会加载假 URL（file:///clients/...）→ ERR_FILE_NOT_FOUND，故统一 goto 回初始入口 */
  let baseUrl: string

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    baseUrl = page.url()
  })

  test.afterAll(async () => {
    // e2e 模式：SIGKILL 终止主进程（零依赖优雅退出），随后 close() 加 5s 超时保护
    if (app) {
      try {
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
    }
  })

  test('新建 → 默认子文件夹 → 子文件夹导入文件 → 列表/详情数据', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-e2e-'))
    const create = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(create.success).toBe(true)

    const cRes = await page.evaluate(async () =>
      (window as any).qihebox.clients.create({
        name: 'E2E客户甲',
        alias: 'AliasA',
        country: '中国',
        tags: ['e2e标'],
        notes: 'e2e 备注',
      }),
    )
    expect(cRes.success).toBe(true)
    expect(cRes.data.name).toBe('E2E客户甲')

    // 客户目录 + 默认子文件夹（报价/合同/沟通/其他，config.customer_subfolders）真实创建
    const customerDir = path.join(wsDir, '客户', 'E2E客户甲')
    for (const sub of ['报价', '合同', '沟通', '其他']) {
      const st = await fsp.stat(path.join(customerDir, sub))
      expect(st.isDirectory()).toBe(true)
    }

    // 列表含档案字段
    const list = await page.evaluate(async () => (window as any).qihebox.clients.list())
    expect(list.success).toBe(true)
    const c = list.data.find((x: { name: string }) => x.name === 'E2E客户甲')
    expect(c.alias).toBe('AliasA')
    expect(c.country).toBe('中国')
    expect(c.tags).toContain('e2e标')

    // 子文件夹导入（scope='customer'，product_set 槽位承载客户名）→ files.list 可见且路径位于 客户/ 区
    const src = path.join(wsDir, '..', `e2e-客户文件-${Date.now()}.pdf`)
    await fsp.writeFile(src, '%PDF-1.4')
    const impEv = (await page.evaluate(async (p) => {
      const qb = (window as any).qihebox
      return new Promise((resolve) => {
        const unsub = qb.events.on('import:complete', (d: any) => {
          unsub()
          resolve(d)
        })
        void qb.files.import({
          source_paths: [p],
          target_product_set: 'E2E客户甲',
          target_folder: '',
          target_type: '',
          sub_folder: '报价',
          scope: 'customer',
        })
      })
    }, src)) as { success: boolean }
    expect(impEv.success).toBe(true)

    const flist = await page.evaluate(async () =>
      (window as any).qihebox.files.list({ product_set: 'E2E客户甲', file_type: '', sub_folder: '报价', scope: 'customer' }),
    )
    expect(flist.success).toBe(true)
    expect(flist.data).toHaveLength(1)
    expect(flist.data[0].path).toContain(path.join('客户', 'E2E客户甲', '报价').split(path.sep).join('/'))
    // 文件真实落盘
    await expect(fsp.stat(flist.data[0].path)).resolves.toBeTruthy()
    // 客户文件数联动（目录扫描为实）
    const list2 = await page.evaluate(async () => (window as any).qihebox.clients.list())
    expect(list2.data.find((x: { name: string }) => x.name === 'E2E客户甲').file_count).toBeGreaterThanOrEqual(1)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('全局搜索命中客户（别名）与客户区文件；客户详情路由 UI 渲染', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-e2e2-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.clients.create({ name: '搜索客户乙', alias: 'SearchB' }))
    // 客户区文件（工作区相对路径）参与全局搜索
    await fsp.writeFile(path.join(wsDir, '客户', '搜索客户乙', '合同', '采购合同-乙.pdf'), 'x')

    const r = await page.evaluate(async () => (window as any).qihebox.search('SearchB'))
    expect(r.success).toBe(true)
    expect(r.data.customers.some((c: any) => c.name === '搜索客户乙')).toBe(true)
    const r2 = await page.evaluate(async () => (window as any).qihebox.search('采购合同-乙'))
    expect(r2.success).toBe(true)
    expect(r2.data.files.some((f: any) => f.name === '采购合同-乙.pdf')).toBe(true)

    // 客户详情路由 UI：reload 让渲染层经应用启动流同步 currentWorkspace，再导航 /clients/:name
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate(async (name) => {
      window.history.pushState({}, '', `/clients/${encodeURIComponent(name)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, '搜索客户乙')
    await expect(page.getByRole('heading', { name: '搜索客户乙' })).toBeVisible({ timeout: 15000 })
    // 档案卡（详情态标题唯一；避免 getByText 命中多个含「客户档案」的节点）
    await expect(page.getByRole('heading', { name: '客户档案' })).toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('删除 → 回收站（kind=customer）→ 恢复 → 列表复原', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-e2e3-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.clients.create({ name: '回收客户丙' }))

    const del = await page.evaluate(async () => (window as any).qihebox.clients.delete('回收客户丙'))
    expect(del.success).toBe(true)
    await expect(fsp.stat(path.join(wsDir, '客户', '回收客户丙'))).rejects.toThrow()

    const trash = await page.evaluate(async () => (window as any).qihebox.trash.list())
    const entry = trash.data.find((t: any) => t.kind === 'customer' && t.name === '回收客户丙')
    expect(entry).toBeTruthy()

    const restore = await page.evaluate(async (id) => (window as any).qihebox.trash.restore(id), entry.id)
    expect(restore.success).toBe(true)
    await expect(fsp.stat(path.join(wsDir, '客户', '回收客户丙'))).resolves.toBeTruthy()

    const list = await page.evaluate(async () => (window as any).qihebox.clients.list())
    expect(list.data.some((c: any) => c.name === '回收客户丙')).toBe(true)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('编辑档案填 type/phone/email/address → 保存 → 详情可见（v2.4.9 S1）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-e2e-s1-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.clients.create({ name: 'S1编辑客户' }))

    // 回初始入口重跑应用启动流（同步 currentWorkspace）；不能 page.reload()——history URL 可能被既有测试 pushState 污染
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate(async (name) => {
      window.history.pushState({}, '', `/clients/${encodeURIComponent(name)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, 'S1编辑客户')
    await expect(page.getByRole('heading', { name: 'S1编辑客户' })).toBeVisible({ timeout: 15000 })

    // 打开编辑档案弹窗（弹窗内唯一 select = 客户类型下拉；placeholder 区分三个输入框）
    await page.getByRole('button', { name: /编辑档案/ }).click()
    const modal = page.locator('.fixed.inset-0', { has: page.getByRole('heading', { name: '编辑客户档案' }) })
    await expect(modal).toBeVisible()

    await modal.locator('select').selectOption('企业')
    await modal.getByPlaceholder('如：13800138000').fill('13800138000')
    await modal.getByPlaceholder('如：name@example.com').fill('s1@example.com')
    await modal.getByPlaceholder('如：浙江省义乌市…').fill('浙江省义乌市')
    await modal.getByRole('button', { name: '保存' }).click()
    await expect(modal).not.toBeVisible()

    // 详情页档案卡新字段可见
    await expect(page.getByText('企业', { exact: true })).toBeVisible()
    await expect(page.getByText('13800138000', { exact: true })).toBeVisible()
    await expect(page.getByText('s1@example.com', { exact: true })).toBeVisible()
    await expect(page.getByText('浙江省义乌市', { exact: true })).toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('旧客户（无新字段）详情：新字段灰显占位（v2.4.9 S1）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-e2e-s1old-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.clients.create({ name: 'S1旧客户' }))

    // 同 A：回初始入口重跑应用启动流
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate(async (name) => {
      window.history.pushState({}, '', `/clients/${encodeURIComponent(name)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, 'S1旧客户')
    await expect(page.getByRole('heading', { name: 'S1旧客户' })).toBeVisible({ timeout: 15000 })

    // 新字段 InfoRow：值灰显占位「—」+ text-surface-300（旧档案无新字段 → undefined 占位）
    for (const label of ['客户类型', '电话', '邮箱', '地址']) {
      const value = page.getByText(label, { exact: true }).locator('xpath=following-sibling::span')
      await expect(value).toHaveText('—')
      await expect(value).toHaveClass(/text-surface-300/)
    }

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('新建客户弹窗填 type/电话/邮箱/地址 → 详情可见（v2.4.9 打磨 M2）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-e2e-m2-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    // 回初始入口重跑应用启动流（同步 currentWorkspace），再进客户列表页
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate(() => {
      window.history.pushState({}, '', '/clients')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })
    // 无客户时 头部 + 空状态 两个「新建客户」按钮并存 → .first() 规避 strict mode
    await expect(page.getByRole('button', { name: /新建客户/ }).first()).toBeVisible({ timeout: 15000 })
    await page.getByRole('button', { name: /新建客户/ }).first().click()

    const modal = page.locator('.fixed.inset-0', { has: page.getByRole('heading', { name: '新建客户' }) })
    await expect(modal).toBeVisible()

    await modal.getByPlaceholder('如：张三').fill('M2新建客户')
    // 新建弹窗加 type select 后仍为弹窗内唯一 select（TagInput 无原生 select），沿用 modal.locator('select') 模式
    await modal.locator('select').selectOption('企业')
    await modal.getByPlaceholder('如：13800138000').fill('13800138000')
    await modal.getByPlaceholder('如：name@example.com').fill('m2@example.com')
    await modal.getByPlaceholder('如：浙江省义乌市…').fill('浙江省义乌市')
    await modal.getByRole('button', { name: '确认创建' }).click()
    await expect(modal).not.toBeVisible()

    // 详情页档案卡：type/电话/邮箱/地址 可见
    await page.evaluate(async (name) => {
      window.history.pushState({}, '', `/clients/${encodeURIComponent(name)}`)
      window.dispatchEvent(new PopStateEvent('popstate'))
    }, 'M2新建客户')
    await expect(page.getByRole('heading', { name: 'M2新建客户' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('企业', { exact: true })).toBeVisible()
    await expect(page.getByText('13800138000', { exact: true })).toBeVisible()
    await expect(page.getByText('m2@example.com', { exact: true })).toBeVisible()
    await expect(page.getByText('浙江省义乌市', { exact: true })).toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('客户列表类型筛选：企业/个人/未分类（v2.4.9 打磨 M3）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clients-e2e-m3-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    // 建 企业 + 个人 + 未分类 三客户（未分类不传 type → undefined；提交映射由 core assertCustomerType 兜底）
    await page.evaluate(async () => {
      const qb = (window as any).qihebox
      const r1 = await qb.clients.create({ name: '类型企业客户', type: '企业' })
      const r2 = await qb.clients.create({ name: '类型个人客户', type: '个人' })
      const r3 = await qb.clients.create({ name: '类型未分类客户' })
      return [r1, r2, r3]
    })
    const list = await page.evaluate(async () => (window as any).qihebox.clients.list())
    expect(list.success).toBe(true)
    expect(list.data.map((c: any) => c.name)).toEqual(
      expect.arrayContaining(['类型企业客户', '类型个人客户', '类型未分类客户']),
    )

    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate(() => {
      window.history.pushState({}, '', '/clients')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    // 筛选区「客户类型」下拉（aria-label 定位，r3 拍板）；默认「全部类型」三客户全显
    const typeFilter = page.getByRole('combobox', { name: '客户类型' })
    await expect(typeFilter).toBeVisible({ timeout: 15000 })
    await expect(page.getByText('类型企业客户', { exact: true })).toBeVisible()
    await expect(page.getByText('类型个人客户', { exact: true })).toBeVisible()
    await expect(page.getByText('类型未分类客户', { exact: true })).toBeVisible()

    // 筛「企业」：只显企业
    await typeFilter.selectOption('企业')
    await expect(page.getByText('类型企业客户', { exact: true })).toBeVisible()
    await expect(page.getByText('类型个人客户', { exact: true })).not.toBeVisible()
    await expect(page.getByText('类型未分类客户', { exact: true })).not.toBeVisible()

    // 筛「未分类」（哨兵 __none__ 映射 c.type === undefined）：只显未分类
    await typeFilter.selectOption('__none__')
    await expect(page.getByText('类型未分类客户', { exact: true })).toBeVisible()
    await expect(page.getByText('类型企业客户', { exact: true })).not.toBeVisible()
    await expect(page.getByText('类型个人客户', { exact: true })).not.toBeVisible()

    // 回「全部类型」：三客户恢复全显
    await typeFilter.selectOption('')
    await expect(page.getByText('类型企业客户', { exact: true })).toBeVisible()
    await expect(page.getByText('类型个人客户', { exact: true })).toBeVisible()
    await expect(page.getByText('类型未分类客户', { exact: true })).toBeVisible()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
