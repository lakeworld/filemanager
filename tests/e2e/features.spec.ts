import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** v2.0.1 新功能 e2e：标签体系 / 拖拽拖出 / 复制路径 / 右键菜单操作 */
test.describe('v2.0.1 新功能', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    // e2e 模式：SIGKILL 直接终止主进程（零依赖优雅退出）。
    // 不调用 app.close()：进程已死，close() 反而会等待 CDP 断开导致 90s 超时；
    // 残留子进程（xclip 等）已 unref，CI 容器结束自然清理。
    if (app) {
      try {
        process.kill(app.process().pid!, 'SIGKILL')
      } catch { /* 已退出 */ }
    }
  })

  test('标签 IPC 全链路：上色 → 列表 → 重命名 → 删除', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tags-e2e-'))
    const create = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(create.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '标签集', tags: ['e2e标'] }))

    // 创建 + 上色（v2.0.2 需先 create）
    const createRes = await page.evaluate(async () => (window as any).qihebox.tags.create('e2e标', '#ef4444'))
    expect(createRes.success).toBe(true)
    const colorRes = await page.evaluate(async () => (window as any).qihebox.tags.setColor('e2e标', '#ef4444'))
    expect(colorRes.success).toBe(true)

    // 列表含颜色与计数
    const listRes = await page.evaluate(async () => (window as any).qihebox.tags.list())
    expect(listRes.success).toBe(true)
    const tag = listRes.data.find((t: { name: string }) => t.name === 'e2e标')
    expect(tag.color).toBe('#ef4444')
    expect(tag.count).toBe(1)

    // 重命名同步引用
    const renameRes = await page.evaluate(async () => (window as any).qihebox.tags.rename('e2e标', '新名标'))
    expect(renameRes.success).toBe(true)
    const psRes = await page.evaluate(async () => (window as any).qihebox.productSets.list())
    expect(psRes.data[0].tags).toEqual(['新名标'])

    // 删除清理
    const delRes = await page.evaluate(async () => (window as any).qihebox.tags.delete('新名标'))
    expect(delRes.success).toBe(true)
    const afterRes = await page.evaluate(async () => (window as any).qihebox.productSets.list())
    expect(afterRes.data[0].tags).toEqual([])

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('拖拽拖出：startDrag 越界拒绝（真实拖拽需 dragstart 上下文，手动验证）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-drag-e2e-'))
    const f = path.join(wsDir, '拖出.txt')
    await fsp.writeFile(f, 'x')
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    // 越界文件被 handler 拒绝（在 startDrag 之前抛错，不会挂起）
    const outside = path.join(os.tmpdir(), `qihebox-out-${Date.now()}.txt`)
    await fsp.writeFile(outside, 'x')
    const bad = await page.evaluate(async (p) => (window as any).qihebox.files.startDrag([p]), outside)
    expect(bad.success).toBe(false)

    // 工作区内文件 startDrag 需要真实拖拽会话，此处仅验证 handler 存在且不抛同步错误
    const hasStartDrag = await page.evaluate(() => typeof (window as any).qihebox.files.startDrag)
    expect(hasStartDrag).toBe('function')

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('复制路径 IPC', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-cp-e2e-'))
    const f = path.join(wsDir, '路径.txt')
    await fsp.writeFile(f, 'x')
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    const res = await page.evaluate(async (p) => (window as any).qihebox.files.copyPaths([p]), f)
    expect(res.success).toBe(true)

    const clip = await app.evaluate(({ clipboard }) => clipboard.readText())
    expect(clip).toContain(f)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('右键操作可用：默认程序打开 / 复制路径（IPC 校验）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-ctx-e2e-'))
    const f = path.join(wsDir, '打开.pdf')
    await fsp.writeFile(f, '%PDF-1.4')
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    // 默认程序打开（xdg-open 启动，可能无默认应用但 IPC 路径通过）
    const openRes = await page.evaluate(async (p) => (window as any).qihebox.files.openWithDefaultApp(p), f)
    expect(openRes.success).toBe(true)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})

/** v2.4.0 后端打磨 e2e：文件移动 / 标签删除不复活 / 更新检查 IPC */
test.describe('后端打磨（v2.4.0）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    // e2e 模式：SIGKILL 直接终止主进程（零依赖优雅退出）。
    // 不调用 app.close()：进程已死，close() 反而会等待 CDP 断开导致 90s 超时；
    // 残留子进程（xclip 等）已 unref，CI 容器结束自然清理。
    if (app) {
      try {
        process.kill(app.process().pid!, 'SIGKILL')
      } catch { /* 已退出 */ }
    }
  })

  test('文件移动：move 后目标子文件夹可见、原位置消失', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-move-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '移动集' }))
    // 直接在工作区内写源文件（图包/主图 为默认子文件夹）
    const srcFile = path.join(wsDir, '产品集', '移动集', '图包', '主图', 'move.jpg')
    await fsp.writeFile(srcFile, 'x')

    const targetDir = path.join(wsDir, '产品集', '移动集', '图包', '详情页')
    const mv = await page.evaluate(
      async ([p, t]: string[]) => (window as any).qihebox.files.move({ paths: [p], targetDir: t }),
      [srcFile, targetDir],
    )
    expect(mv.success).toBe(true)
    expect(mv.data).toHaveLength(1)

    const listSrc = await page.evaluate(async () =>
      (window as any).qihebox.files.list({ product_set: '移动集', file_type: 'image', sub_folder: '主图' }),
    )
    const listDst = await page.evaluate(async () =>
      (window as any).qihebox.files.list({ product_set: '移动集', file_type: 'image', sub_folder: '详情页' }),
    )
    // 原位置消失、目标子文件夹可见
    expect(listSrc.data.map((f: { name: string }) => f.name)).not.toContain('move.jpg')
    expect(listDst.data.map((f: { name: string }) => f.name)).toContain('move.jpg')

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('标签删除不复活：create → delete → 两次 list 均不含', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tagdel-e2e-'))
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    const name = `e2e-临时标-${Date.now()}`

    const createRes = await page.evaluate(async (n) => (window as any).qihebox.tags.create(n, '#3b82f6'), name)
    expect(createRes.success).toBe(true)

    const delRes = await page.evaluate(async (n) => (window as any).qihebox.tags.delete(n), name)
    expect(delRes.success).toBe(true)

    const list1 = await page.evaluate(async () => (window as any).qihebox.tags.list())
    expect(list1.success).toBe(true)
    expect(list1.data.some((t: { name: string }) => t.name === name)).toBe(false)
    // 再查一次仍不含（删除后不复活）
    const list2 = await page.evaluate(async () => (window as any).qihebox.tags.list())
    expect(list2.data.some((t: { name: string }) => t.name === name)).toBe(false)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('更新检查 IPC：updater.check 返回 ApiResult 结构', async () => {
    // 主进程 fetch stub 较复杂，checkUpdate 行为已由 tests/unit/updater.test.ts 全量覆盖；
    // 此处仅验证 IPC 通道存在且返回统一 ApiResult 包装（真实网络失败时 success=false）
    const r = await page.evaluate(async () => (window as any).qihebox.updater.check())
    expect(r).toBeTruthy()
    expect(typeof r).toBe('object')
    expect('success' in r).toBe(true)
  })
})
