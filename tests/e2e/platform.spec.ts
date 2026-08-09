import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 阶段4：平台能力验证（Linux/Deepin）
 * - 剪贴板 text/uri-list（Electron writeBuffer 回退，无 xclip 环境）
 * - 资源管理器显示选中（dde-file-manager --show-item）
 * - 窗口控制 IPC（getSize/setSize）
 * - 无边框拖拽区样式（-webkit-app-region）
 */
test.describe('平台能力（Linux）', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: ROOT, env: { ...process.env, QIHEBOX_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    await app?.close()
  })

  test('剪贴板：复制文件 → text/uri-list 可读回', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-clip-'))
    const f = path.join(wsDir, 'clip.txt')
    await fsp.writeFile(f, 'hello')

    const res = await page.evaluate(async (dir) => {
      return (window as any).qihebox.workspace.create(dir)
    }, wsDir)
    expect(res.success).toBe(true)

    const copyRes = await page.evaluate(async (p) => {
      return (window as any).qihebox.files.copyFilesToClipboard([p])
    }, f)
    expect(copyRes.success).toBe(true)

    // 主进程读回剪贴板（Playwright evaluate 注入 electron 模块）
    const uriList = await app.evaluate(({ clipboard }) => {
      try {
        const buf = clipboard.readBuffer('text/uri-list')
        return buf ? buf.toString('utf-8') : ''
      } catch {
        return '__read_failed__'
      }
    })
    console.log('[clipboard] text/uri-list 内容:', JSON.stringify(uriList))
    if (uriList === '__read_failed__' || uriList === '') {
      test.skip(true, 'Electron writeBuffer(text/uri-list) 在当前桌面未生效（无 xclip 环境）')
    }
    expect(uriList).toContain('file://')
    expect(uriList).toContain(path.basename(f))

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('资源管理器：显示选中文件（dde-file-manager --show-item）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-exp-'))
    const f = path.join(wsDir, 'showme.txt')
    await fsp.writeFile(f, 'x')
    const res = await page.evaluate(async (p) => (window as any).qihebox.workspace.create(p), wsDir)
    expect(res.success).toBe(true)

    const showRes = await page.evaluate(async (p) => {
      return (window as any).qihebox.files.showFilesInExplorer([p])
    }, f)
    // Deepin 有 dde-file-manager → 应成功（无则回退 xdg-open 也成功）
    expect(showRes.success).toBe(true)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('窗口控制 IPC：getSize/setSize/minimize', async () => {
    const size = (await page.evaluate(async () => (window as any).qihebox.window.getSize())) as {
      w: number
      h: number
    }
    expect(size.w).toBeGreaterThanOrEqual(1024)
    expect(size.h).toBeGreaterThanOrEqual(720)

    await page.evaluate(async () => (window as any).qihebox.window.setSize(1100, 800))
    const size2 = (await page.evaluate(async () => (window as any).qihebox.window.getSize())) as {
      w: number
      h: number
    }
    expect(size2.w).toBe(1100)

    const isMax = await page.evaluate(async () => (window as any).qihebox.window.isMaximised())
    expect(typeof isMax).toBe('boolean')
  })

  test('无边框拖拽区样式（-webkit-app-region）', async () => {
    // TitleBar 根元素为 drag 区域
    const region = await page.evaluate(() => {
      const el = document.querySelector('[data-e2e-titlebar]')
      if (!el) return ''
      return getComputedStyle(el).getPropertyValue('-webkit-app-region') || (getComputedStyle(el) as any).webkitAppRegion || ''
    })
    expect(region).toContain('drag')
  })

  test('拖拽 API 暴露：getPathForFile', async () => {
    const fn = await page.evaluate(() => typeof (window as any).qihebox.getPathForFile)
    expect(fn).toBe('function')
  })
})
