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
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('标签 IPC 全链路：上色 → 列表 → 重命名 → 删除', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-tags-e2e-'))
    const create = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(create.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '标签集', tags: ['e2e标'] }))

    // 上色
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

  test('拖拽拖出：startDrag IPC 返回成功', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-drag-e2e-'))
    const f = path.join(wsDir, '拖出.txt')
    await fsp.writeFile(f, 'x')
    await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)

    const res = await page.evaluate(async (p) => (window as any).qihebox.files.startDrag([p]), f)
    expect(res.success).toBe(true)

    // 越界文件拒绝
    const outside = path.join(os.tmpdir(), `qihebox-out-${Date.now()}.txt`)
    await fsp.writeFile(outside, 'x')
    const bad = await page.evaluate(async (p) => (window as any).qihebox.files.startDrag([p]), outside)
    expect(bad.success).toBe(false)

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
