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
  /** 应用初始入口 URL（file:// index.html）；既有测试 pushState 会改 history URL，重载需回初始入口 */
  let baseUrl: string

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
    baseUrl = page.url()
  })

  test.afterAll(async () => {
    // e2e 模式：SIGKILL 终止主进程（零依赖优雅退出），随后 close() 加 5s 超时保护——
    // 进程已死时 close 应快速返回（关闭 Playwright 内部句柄，避免 worker teardown 等待）；
    // 极端情况 close 内部卡住时 race 兜底，不让 afterAll 拖到 90s。
    if (app) {
      try {
        // 杀整个进程组（主进程 + Chromium 子进程）：仅杀主进程会残留 renderer/gpu，
        // Playwright worker teardown 会等待残留进程退出而超时 90s
        process.kill(-app.process().pid!, 'SIGKILL')
      } catch {
        try {
          process.kill(app.process().pid!, 'SIGKILL')
        } catch { /* 已退出 */ }
      }
      await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))]).catch(() => {})
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

  test('「我的」页：加入用户群卡片可见（群聊入口/邮箱反馈）', async () => {
    await page.getByRole('button', { name: /我的/ }).click()
    await page.getByRole('heading', { name: '我的' }).waitFor({ timeout: 10000 })
    await expect(page.getByRole('heading', { name: '加入用户群' })).toBeVisible()
    await expect(page.getByText('1252235854@qq.com')).toBeVisible()
    await expect(page.getByRole('button', { name: '打开群聊页面' })).toBeVisible()
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

    // v2.4.6：预览降采样副本（2048px 管线）——previewUrl 生成/命中后走 qihebox://thumb/ 协议
    const prevUrlRes = await page.evaluate(async (p) => (window as any).qihebox.files.previewUrl(p), entry.path)
    expect(prevUrlRes.success).toBe(true)
    expect(prevUrlRes.data).toMatch(/^qihebox:\/\/thumb\//)
    const prevResp = await page.evaluate(async (u) => {
      const r = await fetch(u)
      return { status: r.status, type: r.headers.get('content-type') }
    }, prevUrlRes.data)
    expect(prevResp.status).toBe(200)
    expect(prevResp.type).toContain('image/jpeg')

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

  test('切换子文件夹：缩略图真实加载，无占位残留（UI 冒烟）', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-switch-'))
    const sharp = (await import('sharp')).default
    const makeImg = async (name: string, color: { r: number; g: number; b: number }) => {
      const p = path.join(wsDir, '..', `${name}-${Date.now()}.png`)
      await sharp({ create: { width: 320, height: 240, channels: 3, background: color } })
        .png()
        .toFile(p)
      return p
    }
    const imgMain = await makeImg('main', { r: 30, g: 144, b: 255 })
    const imgDetail = await makeImg('detail', { r: 255, g: 99, b: 71 })

    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.productSets.create({ name: '丝滑系列' }))

    const importTo = async (src: string, subFolder: string) => {
      const ev = await page.evaluate(
        async ({ src, subFolder }) => {
          const qb = (window as any).qihebox
          return new Promise((resolve) => {
            const unsub = qb.events.on('import:complete', (data: any) => {
              unsub()
              resolve(data)
            })
            void qb.files.import({
              source_paths: [src],
              target_product_set: '丝滑系列',
              target_type: 'image',
              sub_folder: subFolder,
            })
          })
        },
        { src, subFolder },
      ) as { success: boolean }
      expect(ev.success).toBe(true)
    }
    await importTo(imgMain, '主图')
    await importTo(imgDetail, '详情页')

    // 驱动路由进入文件浏览页（history 模式：pushState + popstate）
    const goRoute = (sub: string) =>
      page.evaluate(async (sub) => {
        const route = `/files/image/${encodeURIComponent('丝滑系列')}/${encodeURIComponent(sub)}`
        window.history.pushState({}, '', route)
        window.dispatchEvent(new PopStateEvent('popstate'))
      }, sub)

    // 目标文件夹经 files:list 得到的图片数——网格内缩略图数量必须与之对应。
    // 旧实现切文件夹时 count 冻结/行死切片会残留旧文件夹的 img，数量偏多即被这里抓住。
    const thumbCountIn = async (sub: string): Promise<number> => {
      const r = await page.evaluate(
        async (sub) =>
          (window as any).qihebox.files.list({ product_set: '丝滑系列', file_type: 'image', sub_folder: sub }),
        sub,
      )
      expect(r.success).toBe(true)
      return (r.data as { file_type: string }[]).filter((f) => f.file_type === 'image').length
    }

    // 断言可见缩略图真实解码完成（非占位）+ 数量吻合 + 不含上一文件夹残留的 src。
    // excluded：切文件夹前捕获的旧文件夹 src 集合——旧实现残留的旧文件夹 img 也能 complete
    // （"img 存在且 complete"是假绿），因此必须以 src 集合无交集来判真绿。
    const assertThumbsLoaded = (label: string, opts: { excluded: string[]; expected: number }) =>
      page.waitForFunction(
        ({ excluded, expected }) => {
          const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="qihebox://thumb/"]'))
          return (
            imgs.length === expected &&
            imgs.every((i) => i.complete && i.naturalWidth > 0) &&
            !imgs.some((i) => excluded.includes(i.getAttribute('src') ?? ''))
          )
        },
        opts,
        { timeout: 15000 },
      )

    // 1. 主图文件夹：缩略图真实加载
    await goRoute('主图')
    await assertThumbsLoaded('主图', { excluded: [], expected: await thumbCountIn('主图') })
    // 捕获主图文件夹当前渲染的缩略图 src——切到「详情页」后这些 src 必须全部消失
    const mainSrcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLImageElement>('img[src^="qihebox://thumb/"]')).map((i) => i.getAttribute('src') ?? ''),
    )
    expect(mainSrcs.length).toBeGreaterThan(0)

    // 2. 点击「详情页」tab 切换文件夹 → 新文件夹缩略图真实加载，且不残留主图 img（修复 1 的回归断言）
    await page.getByRole('button', { name: '详情页', exact: true }).click()
    await assertThumbsLoaded('详情页', { excluded: mainSrcs, expected: await thumbCountIn('详情页') })

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('M5 仪表盘：供应商/报价统计卡 + 草稿报价副链接跳转筛选', async () => {
    const wsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'qihebox-e2e-dash-'))

    // 建 1 供应商 + 2 报价（草稿/已确认 各 1：验证 总报价数=2 且 subText 草稿=1；目录扫描口径经 UI 数字断言）
    const createRes = await page.evaluate(async (dir) => (window as any).qihebox.workspace.create(dir), wsDir)
    expect(createRes.success).toBe(true)
    await page.evaluate(async () => (window as any).qihebox.suppliers.create({ name: '仪表盘供应商' }))
    await page.evaluate(async () =>
      (window as any).qihebox.quotes.create({
        quotation_no: 'QT-DASH-001',
        date: '2026-08-01',
        lines: [{ product: '草稿品', qty: 1, unit_price: 10, amount: 10 }],
      }),
    )
    await page.evaluate(async () =>
      (window as any).qihebox.quotes.create({
        quotation_no: 'QT-DASH-002',
        date: '2026-08-02',
        lines: [{ product: '确认品', qty: 1, unit_price: 20, amount: 20 }],
      }),
    )
    await page.evaluate(async () => (window as any).qihebox.quotes.setStatus('QT-DASH-002', '已确认'))

    // 重载回初始入口同步渲染层工作区（裸 IPC workspace.create 只切主进程 currentWS，渲染层 signal 需整页重载后
    // loadCurrentWorkspace 对齐——既有 gotoRoute 基建同款），再导航到仪表盘（/）触发 stats 拉取
    await page.goto(baseUrl)
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => !!(window as any).qihebox, null, { timeout: 10000 })
    await page.evaluate(() => {
      window.history.pushState({}, '', '/')
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

    // 统计卡数字：供应商=1（目录扫描口径）、报价总数=2（卡片容器定位 + 卡内精确值）
    const supplierCard = page.getByTitle('查看全部供应商')
    await expect(supplierCard.getByText('1', { exact: true })).toBeVisible({ timeout: 15000 })
    const quoteCard = page.locator('div.card', { has: page.getByRole('link', { name: '草稿 1 条' }) })
    await expect(quoteCard.getByText('2', { exact: true })).toBeVisible()

    // 报价卡 subText 独立链接（外层 div 非 A，规避嵌套锚点）→ 点击跳转 /quotes?status=草稿
    await page.getByRole('link', { name: '草稿 1 条' }).click()
    await expect(page.getByRole('heading', { name: '报价管理' })).toBeVisible({ timeout: 15000 })
    // 报价页 URL 预选：状态下拉=草稿 + 列表仅草稿（QT-DASH-002 已确认 → 隐藏）
    await expect(page.getByLabel('状态筛选')).toHaveValue('草稿')
    await expect(page.getByText('QT-DASH-001', { exact: true })).toBeVisible()
    await expect(page.getByText('QT-DASH-002', { exact: true })).toHaveCount(0)

    await fsp.rm(wsDir, { recursive: true, force: true }).catch(() => {})
  })

  test('TitleBar 最大化图标随主进程广播同步（v2.5.2）', async () => {
    // 测「主进程广播 → 渲染层订阅」链路本体：window.ts on('maximize') → sendMaximizedChanged →
    // 渲染层 TitleBar 刷新。手动 emit 事件而非真实 maximize()：Linux 无 WM（CI xvfb）下
    // maximize() 的 _NET_WM_STATE 请求无人处理、maximize 事件不触发（Electron 依赖 WM 确认），
    // 真实 WM 行为属 Electron 职责不在本用例范围；广播链路即 v2.5.2 修复本体。
    const titlebar = page.locator('[data-e2e-titlebar]')
    await titlebar.waitFor({ timeout: 10000 })
    // 初始态：非最大化 → 按钮 title=最大化（onMount 查询兜底）
    await titlebar.locator('button[title="最大化"]').waitFor({ timeout: 5000 })

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit('maximize')
      return true
    })
    await titlebar.locator('button[title="还原"]').waitFor({ timeout: 5000 })

    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit('unmaximize')
      return true
    })
    await titlebar.locator('button[title="最大化"]').waitFor({ timeout: 5000 })
  })
})
