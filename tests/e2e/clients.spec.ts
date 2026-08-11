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

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
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
})
