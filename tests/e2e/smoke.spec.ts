import { test, expect, _electron as electron } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * e2e 冒烟：启动应用 → 建工作区 → 建产品集 → 检查 Dashboard。
 * 覆盖阶段 0/1 的核心 IPC 链路（window.qihebox → 主进程 → core → 文件系统）。
 */
test.describe('qihe-box e2e', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, QIHEBOX_E2E: '1' },
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // 等待 preload 注入完成
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
  })

  test.afterAll(async () => {
    // e2e 模式：直接 kill 主进程（零依赖主进程配合），避免 close() 等待 90s 超时
    if (app) {
      try {
        app.process().kill()
      } catch { /* 已退出 */ }
      await app.close().catch(() => {})
    }
  })

  test('窗口加载且 window.qihebox 可用', async () => {
    const title = await page.title()
    expect(title).toBe('启禾文件管理')
    const hasApi = await page.evaluate(() => {
      const qb = (window as any).qihebox
      return !!qb && typeof qb.workspace?.create === 'function'
    })
    expect(hasApi).toBe(true)
  })

  test('建工作区 → 建产品集 → 列表可见', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-'))

    const createRes = await page.evaluate(async (dir) => {
      return (window as any).qihebox.workspace.create(dir)
    }, wsDir)
    expect(createRes.success).toBe(true)
    expect(createRes.data.path).toBe(wsDir)

    const psRes = await page.evaluate(async () => {
      return (window as any).qihebox.productSets.create({ name: 'E2E系列' })
    })
    expect(psRes.success).toBe(true)
    expect(psRes.data.name).toBe('E2E系列')

    const listRes = await page.evaluate(async () => {
      return (window as any).qihebox.productSets.list()
    })
    expect(listRes.success).toBe(true)
    expect(listRes.data.map((p: { name: string }) => p.name)).toContain('E2E系列')

    // 目录真实存在
    const stat = await fsp.stat(path.join(wsDir, '产品集', 'E2E系列'))
    expect(stat.isDirectory()).toBe(true)

    await fsp.rm(wsDir, { recursive: true, force: true })
  })

  test('Dashboard 统计可读取', async () => {
    const stats = await page.evaluate(async () => (window as any).qihebox.dashboard.stats())
    expect(stats.success).toBe(true)
    expect(typeof stats.data.total_product_sets).toBe('number')
  })

  test('应用版本号', async () => {
    const version = await page.evaluate(async () => (window as any).qihebox.app.version())
    expect(typeof version).toBe('string')
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('导入图片 → sharp 缩略图 → qihebox:// 协议加载（阶段2/3）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-img-'))
    const imgSrc = path.join(wsDir, '..', `src-${Date.now()}.png`)
    // 用 sharp 生成合法 PNG（400x300），避免手写 base64 损坏
    const sharp = (await import('sharp')).default
    await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 200, g: 80, b: 40 } },
    })
      .png()
      .toFile(imgSrc)

    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '图集' }))

    // 导入为异步（立即返回，完成发 import:complete 事件），等待事件后取列表
    const importEvent = await page.evaluate(async (src) => {
      const qb = (window as any).qihebox
      return new Promise((resolve) => {
        const unsub = qb.events.on('import:complete', (data: any) => {
          unsub()
          resolve(data)
        })
        void qb.files.import({
          source_paths: [src],
          target_product_set: '图集',
          target_folder: '主图',
          target_type: 'image',
          sub_folder: '主图',
        })
      })
    }, imgSrc) as { success: boolean }
    expect(importEvent.success).toBe(true)

    const listRes = await page.evaluate(async () =>
      (window as any).qihebox.files.list({ product_set: '图集', file_type: 'image', sub_folder: '主图' }),
    )
    expect(listRes.success).toBe(true)
    expect(listRes.data).toHaveLength(1)
    const entry = listRes.data[0]

    // 缩略图：ensureThumbnail 返回路径（缺失自动生成）
    const thumbRes = await page.evaluate(async (p) => (window as any).qihebox.files.ensureThumbnail(p), entry.path)
    expect(thumbRes.success).toBe(true)
    expect(thumbRes.data).toBeTruthy()
    await expect(fsp.stat(thumbRes.data)).resolves.toBeTruthy()

    // 文件 URL → qihebox:// 协议
    const urlRes = await page.evaluate(async (p) => (window as any).qihebox.files.workspaceUrl(p), entry.path)
    expect(urlRes.success).toBe(true)
    expect(urlRes.data).toMatch(/^qihebox:\/\/file\//)

    // 渲染进程经协议加载原图
    const imgResp = await page.evaluate(async (u) => {
      const r = await fetch(u)
      return { status: r.status, type: r.headers.get('content-type') }
    }, urlRes.data)
    expect(imgResp.status).toBe(200)
    expect(imgResp.type).toContain('image/png')

    // 协议加载缩略图（v2.1.0：缩略图缓存位于 userData，走 qihebox://thumb/，不再经工作区 file host）
    const thumbUrlRes = await page.evaluate(async (p) => (window as any).qihebox.files.thumbnailUrl(p), entry.path)
    expect(thumbUrlRes.success).toBe(true)
    expect(thumbUrlRes.data).toMatch(/^qihebox:\/\/thumb\//)
    const thumbResp = await page.evaluate(async (u) => {
      const r = await fetch(u)
      return { status: r.status, type: r.headers.get('content-type') }
    }, thumbUrlRes.data)
    expect(thumbResp.status).toBe(200)
    expect(thumbResp.type).toContain('image/jpeg')

    // 越界文件被协议拒绝
    const outside = path.join(os.tmpdir(), `qihebox-outside-${Date.now()}.png`)
    await sharp({ create: { width: 10, height: 10, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toFile(outside)
    const outsideUrlRes = await page.evaluate(async (p) => (window as any).qihebox.files.workspaceUrl(p), outside)
    expect(outsideUrlRes.success).toBe(false)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('导入 PDF → 不生成缩略图（v2.1.0 决策：证书以预览查看），协议不可越界', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-pdf-'))
    const pdfSrc = path.join(wsDir, '..', `src-pdf-${Date.now()}.pdf`)
    // 手写最小合法 PDF（精确 xref 偏移）
    const objs: string[] = []
    objs[1] = '<</Type/Catalog/Pages 2 0 R>>'
    objs[2] = '<</Type/Pages/Kids[3 0 R]/Count 1>>'
    objs[3] = '<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>'
    const stream = 'BT /F1 12 Tf 20 60 Td (Hi) Tj ET'
    objs[4] = `<</Length ${stream.length}>>stream\n${stream}\nendstream`
    objs[5] = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
    let pdf = '%PDF-1.4\n'
    const offsets: number[] = []
    for (let i = 1; i <= 5; i++) {
      offsets[i] = Buffer.byteLength(pdf)
      pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`
    }
    const xrefPos = Buffer.byteLength(pdf)
    pdf += 'xref\n0 6\n0000000000 65535 f \n'
    for (let i = 1; i <= 5; i++) {
      pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
    }
    pdf += `trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`
    await fsp.writeFile(pdfSrc, Buffer.from(pdf, 'utf-8'))

    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '证书集' }))

    const importEvent = await page.evaluate(async (src) => {
      const qb = (window as any).qihebox
      return new Promise((resolve) => {
        const unsub = qb.events.on('import:complete', (data: any) => {
          unsub()
          resolve(data)
        })
        void qb.files.import({
          source_paths: [src],
          target_product_set: '证书集',
          target_folder: '3C',
          target_type: 'cert',
          sub_folder: '3C',
        })
      })
    }, pdfSrc) as { success: boolean }
    expect(importEvent.success).toBe(true)

    const listRes = await page.evaluate(async () =>
      (window as any).qihebox.files.list({ product_set: '证书集', file_type: 'cert', sub_folder: '3C' }),
    )
    expect(listRes.success).toBe(true)
    expect(listRes.data).toHaveLength(1)
    const entry = listRes.data[0]

    // PDF 不生成缩略图（v2.1.0 决策：缩略图仅图片；证书以 pdfjs 预览查看为准）
    const thumbRes = await page.evaluate(async (p) => (window as any).qihebox.files.ensureThumbnail(p), entry.path)
    expect(thumbRes.success).toBe(true)
    expect(thumbRes.data).toBeFalsy()

    // thumbnailUrl 同样返回空（不产生 PDF 缩略图缓存）
    const thumbUrlRes = await page.evaluate(async (p) => (window as any).qihebox.files.thumbnailUrl(p), entry.path)
    expect(thumbUrlRes.success).toBe(true)
    expect(thumbUrlRes.data).toBeFalsy()

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })
})
